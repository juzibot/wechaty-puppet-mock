#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import {
  test,
}             from 'tstest'

import * as PUPPET  from '@juzi/wechaty-puppet'
import {
  FileBox,
}                 from 'file-box'

import { PuppetMock }     from '../puppet-mock.js'

import type { CallMockTiming }    from './call-mock.js'
import type { ContactMock }       from './user/contact-mock.js'

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

async function waitFor (isReady: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isReady()) {
      return true
    }
    await sleep(5)
  }
  return isReady()
}

const FAST_TIMING: CallMockTiming = {
  answerMaxMs    : 30,
  answerMinMs    : 10,
  hangupMaxMs    : 20,
  hangupMinMs    : 10,
  ringingDelayMs : 5,
}

interface CallFixture {
  events : PUPPET.payloads.EventCall[],
  peer   : ContactMock,
  puppet : PuppetMock,
  self   : ContactMock,
}

function createFixture (timing: CallMockTiming = FAST_TIMING): CallFixture {
  const puppet = new PuppetMock({ callTiming: timing })

  const peer = puppet.mocker.createContact()
  const self = puppet.mocker.createContact()
  puppet.mocker.login(self)

  const events: PUPPET.payloads.EventCall[] = []
  puppet.on('call', payload => { events.push(payload) })

  return { events, peer, puppet, self }
}

function signalsOf (fixture: CallFixture): PUPPET.types.CallSignal[] {
  return fixture.events.map(event => event.signal)
}

test('callInviteWithMedia() without file: ringing -> accept -> fallback hangup', async t => {
  const fixture = createFixture()
  const { peer, puppet } = fixture

  const callId = await puppet.callInviteWithMedia([ peer.id ], undefined, { hangupOnFinish: true })
  await sleep(200)

  t.same(signalsOf(fixture), [ 'ringing', 'accept', 'hangup' ], 'should receive the full fallback signal chain')

  const accept = fixture.events[1]!
  const hangup = fixture.events[2]!
  t.equal(accept.contactId, peer.id, 'should the accept signal be acted by the callee')
  t.equal(hangup.contactId, peer.id, 'should the fallback hangup signal be acted by the callee')
  t.equal(hangup.reason, 'mock-fallback-hangup', 'should the fallback hangup carry the reason')

  const payload = await puppet.callPayload(callId)
  t.ok(payload.endTime, 'should endTime be set after the fallback hangup')
})

test('caller hangup() suppresses the fallback hangup event', async t => {
  const fixture = createFixture({
    answerMaxMs    : 30,
    answerMinMs    : 10,
    hangupMaxMs    : 100,
    hangupMinMs    : 50,
    ringingDelayMs : 5,
  })
  const { peer, puppet } = fixture

  const callId = await puppet.callInviteWithMedia([ peer.id ], undefined, { hangupOnFinish: true })
  const accepted = await waitFor(() => fixture.events.some(event => event.signal === PUPPET.types.CallSignal.Accept))
  t.ok(accepted, 'should receive the accept signal before hanging up')

  await puppet.callHangup(callId)

  const eventCount = fixture.events.length
  await sleep(200)  // the fallback window (50-100ms after accept) elapses here
  t.equal(fixture.events.length, eventCount, 'should emit no fallback hangup after the caller hangup')

  const payload = await puppet.callPayload(callId)
  t.ok(payload.endTime, 'should endTime be set after the caller hangup')
})

test('callInviteWithMedia() schedules the fallback hangup after the media duration', async t => {
  const fixture = createFixture({
    answerMaxMs    : 30,
    answerMinMs    : 20,
    hangupMaxMs    : 20,
    hangupMinMs    : 10,
    ringingDelayMs : 5,
  })
  const { peer, puppet } = fixture

  const file = FileBox.fromBuffer(Buffer.alloc(8), 'voice.mp3')
  file.metadata = { duration: 1 }

  await puppet.callInviteWithMedia([ peer.id ], file)
  await sleep(1200)

  const accept = fixture.events.find(event => event.signal === PUPPET.types.CallSignal.Accept)
  const hangup = fixture.events.find(event => event.signal === PUPPET.types.CallSignal.Hangup)
  t.ok(accept, 'should receive the accept signal')
  t.ok(hangup, 'should receive the fallback hangup signal')

  const hangupDelay = hangup!.timestamp - accept!.timestamp
  t.ok(hangupDelay >= 990, 'should the fallback hangup wait for the 1s media duration (got ' + hangupDelay + 'ms)')
})

test('callInviteWithMedia() validations', async t => {
  const { peer, puppet } = createFixture()

  await t.rejects(
    puppet.callInviteWithMedia([ peer.id ]),
    /hangupOnFinish must be true/,
    'should reject when file is empty and hangupOnFinish is not true',
  )
  await t.rejects(
    puppet.callInviteWithMedia([ peer.id, puppet.currentUserId ], undefined, { hangupOnFinish: true }),
    /1v1 call only/,
    'should reject when there is more than one contactId',
  )
})

test('callInvite() stays ongoing after connected and supports ringing-phase cancel', async t => {
  const fixture = createFixture()
  const { peer, puppet } = fixture

  const callId = await puppet.callInvite([ peer.id ], PUPPET.types.CallMediaType.Audio)
  const accepted = await waitFor(() => fixture.events.some(event => event.signal === PUPPET.types.CallSignal.Accept))
  t.ok(accepted, 'should receive the accept signal')

  const endpoint = await puppet.callMediaEndpoint(callId)
  t.ok(endpoint.url.includes(callId), 'should the media endpoint url embed the callId')
  t.ok(endpoint.token.length > 0, 'should the media endpoint carry a token')

  await t.rejects(
    puppet.callCancel(callId),
    /already connected/,
    'should cancel reject after the call is connected',
  )
  await puppet.callHangup(callId)  // finalize the connected call

  const ringingCallId = await puppet.callInvite([ peer.id ], PUPPET.types.CallMediaType.Audio)
  const eventCount = fixture.events.length
  await puppet.callCancel(ringingCallId)
  await sleep(100)
  t.equal(fixture.events.length, eventCount, 'should receive no accept signal after the ringing-phase cancel')

  const payload = await puppet.callPayload(ringingCallId)
  t.ok(payload.endTime, 'should endTime be set after the ringing-phase cancel')
})
