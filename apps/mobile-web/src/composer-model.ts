export type ComposerMode = 'queue' | 'steer'

export interface ComposerCopy {
  placeholder: string
  sendLabel: string
  mode: ComposerMode
}

export function composerCopy(running: boolean, sending: boolean): ComposerCopy {
  return {
    placeholder: running ? '追加说明或调整方向…' : '发送下一条指令…',
    sendLabel: sending ? '发送中…' : running ? '立即追加' : '发送指令',
    mode: running ? 'steer' : 'queue',
  }
}
