import cuid                            from 'cuid'
import * as PUPPET                     from '@juzi/wechaty-puppet'
import type { FileBoxInterface }       from 'file-box'

import { log }   from '../config.js'

import type { PuppetMock }    from '../puppet-mock.js'

/**
 * Timing knobs (in milliseconds) for the mock call signaling simulation:
 * the callee (mock protocol side) answers within rand[answerMinMs, answerMaxMs],
 * and falls back to hang up at accept + mediaDuration + rand[hangupMinMs, hangupMaxMs].
 */
export interface CallMockTiming {
  ringingDelayMs? : number  // delay before the Ringing signal, default 300
  answerMinMs?    : number  // Accept delay lower bound, default 3000
  answerMaxMs?    : number  // Accept delay upper bound, default 10000
  hangupMinMs?    : number  // fallback Hangup extra delay lower bound, default 3000
  hangupMaxMs?    : number  // fallback Hangup extra delay upper bound, default 10000
}

const DEFAULT_TIMING: Required<CallMockTiming> = {
  answerMaxMs    : 10000,
  answerMinMs    : 3000,
  hangupMaxMs    : 10000,
  hangupMinMs    : 3000,
  ringingDelayMs : 300,
}

/**
 * Media playback duration in milliseconds, read from the fileBox metadata:
 * `duration` (seconds) or `durationMs` (milliseconds), as set by the caller
 * (e.g. bot.call.service.ts buildVoicecallAudioFile).
 *
 * Returns `undefined` when there is no file (pure callInvite), and `0` when
 * the file carries no duration metadata.
 */
function mediaDurationMsOf (file?: FileBoxInterface): number | undefined {
  if (!file) {
    return undefined
  }
  const metadata = file.metadata
  if (typeof metadata['duration'] === 'number') {
    return metadata['duration'] * 1000
  }
  if (typeof metadata['durationMs'] === 'number') {
    return metadata['durationMs']
  }
  return 0
}

function randMs (minMs: number, maxMs: number): number {
  if (maxMs < minMs) {
    return minMs
  }
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1))
}

interface CallMockOptions {
  /** the callee (protocol side) who will answer the call */
  calleeId        : string
  media           : PUPPET.types.CallMediaType
  /** `undefined` = pure callInvite: no fallback hangup after connected */
  mediaDurationMs?: number
  puppet          : PuppetMock
  timing?         : CallMockTiming
}

type CallMockStatus = 'accepted' | 'ended' | 'ringing'

/* eslint no-use-before-define: 0 */
class CallMock {

  static pool: Map<string, CallMock> = new Map()

  static load (callId: string): CallMock {
    const existingCall = CallMock.pool.get(callId)
    if (existingCall) {
      return existingCall
    }
    throw new Error(`CallMock.load(): ${callId} not exist.`)
  }

  static create (options: CallMockOptions): CallMock {
    log.verbose('CallMock', 'static create(calleeId: %s, media: %s)', options.calleeId, options.media)
    const call = new CallMock(options)
    CallMock.pool.set(call.id, call)
    return call
  }

  /** clear every timer and the whole pool (called from puppet onStop) */
  static destroyAll (): void {
    log.verbose('CallMock', 'static destroyAll() pool size: %s', CallMock.pool.size)
    CallMock.pool.forEach(call => call.clearTimers())
    CallMock.pool.clear()
  }

  status: CallMockStatus = 'ringing'

  private timerList: ReturnType<typeof setTimeout>[] = []
  private readonly timing: Required<CallMockTiming>
  private _payload: PUPPET.payloads.Call

  constructor (
    private readonly options: CallMockOptions,
  ) {
    log.verbose('CallMock', 'constructor()')
    this.timing  = { ...DEFAULT_TIMING, ...options.timing }
    this._payload = {
      id           : 'call-' + cuid(),
      media        : options.media,
      participants : [ options.puppet.currentUserId, options.calleeId ],
      startTime    : Date.now(),
      starter      : options.puppet.currentUserId,
    }
  }

  get id      (): string              { return this._payload.id }
  get payload (): PUPPET.payloads.Call { return this._payload }

  /**
   * Simulate the callee side of an outbound call:
   * Ringing -> Accept (random delay), plus a fallback Hangup
   * (media duration + random delay) if the caller never hangs up.
   */
  startOutbound (): void {
    log.verbose('CallMock', 'startOutbound() id: %s', this.id)

    this.scheduleTimer(this.timing.ringingDelayMs, () => this.signal(PUPPET.types.CallSignal.Ringing))
    this.scheduleTimer(randMs(this.timing.answerMinMs, this.timing.answerMaxMs), () => this.onAccepted())
  }

  /** merge new participants into the call roster (callAdd) */
  addParticipants (contactIds: string[]): void {
    const participants = [ ...new Set([ ...this._payload.participants, ...contactIds ]) ]
    if (participants.length === this._payload.participants.length) {
      return
    }
    this._payload = { ...this._payload, participants }
    this.options.puppet.dirtyPayload(PUPPET.types.Payload.Call, this.id)
  }

  /**
   * Caller-side hangup. Emits NO event: per the contract, the hangup signal
   * is only sent to the side that did not act — wechaty Call.hangup()
   * finalizes the caller side locally.
   */
  hangupByCaller (): void {
    if (this.status !== 'accepted') {
      throw new Error('call not connected: can not hangup a call which is not accepted (status: ' + this.status + ')')
    }
    this.end()
  }

  /**
   * Caller-side cancel before the callee answers. Emits NO event (see above).
   */
  cancelByCaller (): void {
    if (this.status === 'accepted') {
      throw new Error('already connected, use callHangup instead')
    }
    this.end()
  }

  private onAccepted (): void {
    this.status = 'accepted'
    this.signal(PUPPET.types.CallSignal.Accept)

    if (this.options.mediaDurationMs === undefined) {
      return  // pure callInvite: stay ongoing until someone hangs up
    }

    const fallbackDelayMs = this.options.mediaDurationMs
      + randMs(this.timing.hangupMinMs, this.timing.hangupMaxMs)
    this.scheduleTimer(fallbackDelayMs, () => {
      if (this.status === 'ended') {
        return
      }
      this.signal(PUPPET.types.CallSignal.Hangup, 'mock-fallback-hangup')
      this.end()
    })
  }

  private signal (signal: PUPPET.types.CallSignal, reason?: string): void {
    log.verbose('CallMock', 'signal(%s, callId: %s)', signal, this.id)
    const payload: PUPPET.payloads.EventCall = {
      callId    : this.id,
      contactId : this.options.calleeId,
      signal,
      timestamp : Date.now(),
      ...(reason && { reason }),
    }
    this.options.puppet.emit('call', payload)
  }

  private end (): void {
    this.clearTimers()
    if (this.status === 'ended') {
      return
    }
    this.status = 'ended'
    this._payload = { ...this._payload, endTime: Date.now() }
    /**
     * Deliberately stay in the pool: the caller re-pulls callPayload()
     * after this dirty event to read the final endTime.
     */
    this.options.puppet.dirtyPayload(PUPPET.types.Payload.Call, this.id)
  }

  private scheduleTimer (milliseconds: number, fn: () => void): void {
    this.timerList.push(setTimeout(fn, milliseconds))
  }

  private clearTimers (): void {
    this.timerList.forEach(timer => clearTimeout(timer))
    this.timerList = []
  }

}

export {
  CallMock,
  mediaDurationMsOf,
}
