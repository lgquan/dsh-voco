/** `voice` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'voice'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'badge.voice': 'VOICE',
  'control.start': '开始语音对话',
  'control.retry': '语音连接失败，点击重试',
  'control.stop': '结束语音对话',
  'overlay.connecting': '正在连接语音',
  'overlay.listening': '正在聆听',
  'overlay.speaking': '正在播放回复',
  'overlay.error': '语音连接失败',
  'overlay.return': '返回语音对话',
  'overlay.stop': '结束',
  'history.open': '打开语音历史',
  'history.label': '语音历史',
  'history.title': '语音对话',
  'history.close': '关闭语音历史',
  'history.empty': '还没有语音对话',
  'history.active': '通话中',
  'history.saved': '已保存',
  'utterance.user.pending': '正在聆听…',
  'utterance.assistant.pending': '正在生成语音回复…',
  'utterance.interrupted': '已打断',
  'task.title': '委派任务',
  'task.status.accepted': '已接受',
  'task.status.queued': '排队中',
  'task.status.running': '执行中',
  'task.status.waiting-user': '等待确认',
  'task.status.completed': '已完成',
  'task.status.failed': '失败',
  'task.status.cancelled': '已取消',
  'task.status.interrupted': '服务中断',
  'task.expand': '展开摘要',
  'task.collapse': '收起摘要',
  'task.open': '打开任务',
} satisfies Record<string, string>

/** Union of this namespace's dictionary keys. */
export type VoiceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'badge.voice': 'VOICE',
  'control.start': 'Start voice conversation',
  'control.retry': 'Voice connection failed, press to retry',
  'control.stop': 'End voice conversation',
  'overlay.connecting': 'Connecting voice',
  'overlay.listening': 'Listening',
  'overlay.speaking': 'Playing response',
  'overlay.error': 'Voice connection failed',
  'overlay.return': 'Return to voice conversation',
  'overlay.stop': 'End',
  'history.open': 'Open voice history',
  'history.label': 'Voice history',
  'history.title': 'Voice conversations',
  'history.close': 'Close voice history',
  'history.empty': 'No voice conversations yet',
  'history.active': 'Active',
  'history.saved': 'Saved',
  'utterance.user.pending': 'Listening…',
  'utterance.assistant.pending': 'Generating voice response…',
  'utterance.interrupted': 'Interrupted',
  'task.title': 'Delegated task',
  'task.status.accepted': 'Accepted',
  'task.status.queued': 'Queued',
  'task.status.running': 'Running',
  'task.status.waiting-user': 'Waiting for you',
  'task.status.completed': 'Completed',
  'task.status.failed': 'Failed',
  'task.status.cancelled': 'Cancelled',
  'task.status.interrupted': 'Interrupted',
  'task.expand': 'Show summary',
  'task.collapse': 'Hide summary',
  'task.open': 'Open task',
} satisfies Record<VoiceKey, string>
