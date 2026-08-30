// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChatConversationViewNode, ClientContext, ConversationEventInput, ConversationNodeDefinition,
  ConversationViewDefinition, SessionId, SessionListState, WorkspaceId, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import { VoiceTaskId, VoiceUtteranceId } from '@flowingspring/dsh-voice'
import {
  VoiceControl, type VoiceControlInjected, type VoiceControlProps,
} from '../src/client/VoiceControl.tsx'
import {
  VoiceDelegationView, type VoiceDelegationViewProps,
  VoiceUtteranceView, type VoiceUtteranceViewProps,
} from '../src/client/VoiceNodeViews.tsx'
import { relativeTimeLabel, VoiceSessionMarkers } from '../src/client/VoiceSessionMarkers.tsx'
import { isSessionEffectivelyArchived } from '../src/client/session-archive.ts'
import { VoiceOverlay, type VoiceOverlayProps } from '../src/client/VoiceOverlay.tsx'
import { VoiceController, type VoiceClientSnapshot } from '../src/client/voice-controller.ts'
import {
  voiceDelegationDefinition, voiceUtteranceDefinition,
} from '../src/client/voice-definitions.ts'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, type VoiceKey, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

const VOICE_SESSION = 'voice-session' as SessionId
const FRESH_VOICE_SESSION = 'fresh-voice-session' as SessionId
const TASK_SESSION = 'task-session' as SessionId
const zhT = ((key: VoiceKey): string => zh[key]) as VoiceControlProps['t']
const enT = ((key: VoiceKey): string => en[key]) as VoiceControlProps['t']

interface ChatSnapshot {
  readonly nodes: ReadonlyMap<string, ChatConversationViewNode>
}

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return [voiceUtteranceDefinition, voiceDelegationDefinition]
  }
  fallbackEntry(): undefined { return undefined }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] { return [chatViewDefinition] }
}

const chatViewDefinition: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> = {
  target: 'chat',
  create: () => {
    let nodes = new Map<string, ChatConversationViewNode>()
    const snapshot = (): ChatSnapshot => ({ nodes })
    return {
      empty: snapshot(),
      replace: ({ nodes: values }) => {
        nodes = new Map(values.map(node => [node.key, node]))
        return snapshot()
      },
      apply: ({ upserts }) => {
        nodes = new Map(nodes)
        for (const node of upserts) nodes.set(node.key, node)
        return snapshot()
      },
    }
  },
}

function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: seq * 100, type, data } as ConversationEventInput['event'], view: undefined }
}

function assembler(events: readonly ConversationEventInput[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(events, hasMore)
  value.flush()
  return value
}

function chatNodes(value: ConversationNodeAssembler): readonly ChatConversationViewNode[] {
  return [...(value.snapshot('chat') as ChatSnapshot).nodes.values()]
}

describe('Voice Conversation Definitions', () => {
  const utteranceId = VoiceUtteranceId('utterance-1')
  const taskId = VoiceTaskId('task-1')
  const events = [
    at(1, 'voice/utterance-start', { utteranceId, role: 'user' }),
    at(2, 'voice/utterance-end', { utteranceId, role: 'user', text: '查一下状态', state: 'completed' }),
    at(3, 'voice/task-delegated', { taskId, taskSessionId: TASK_SESSION, input: '检查构建' }),
    at(4, 'voice/task-observation', { taskId, status: 'running', announcement: '正在执行' }),
    at(5, 'voice/task-observation', {
      taskId,
      status: 'completed',
      voiceMessage: { id: 'message-1', text: '构建通过' },
    }),
  ]

  it('folds durable utterance text and the latest delegated-task report', () => {
    const nodes = chatNodes(assembler(events))
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatchObject({
      kind: 'voice-utterance',
      anchorSeq: 1,
      data: { utteranceId, role: 'user', text: '查一下状态', state: 'completed' },
    })
    expect(nodes[1]).toMatchObject({
      kind: 'voice-delegation',
      anchorSeq: 3,
      data: {
        taskId,
        taskSessionId: TASK_SESSION,
        input: '检查构建',
        status: 'completed',
        update: '构建通过',
        lastActivityAt: 500,
      },
    })
  })

  it('omits empty interrupted utterances from the chat view', () => {
    const noiseId = VoiceUtteranceId('ambient-noise')
    const nodes = chatNodes(assembler([
      at(1, 'voice/utterance-start', { utteranceId: noiseId, role: 'user' }),
      at(2, 'voice/utterance-end', {
        utteranceId: noiseId, role: 'user', text: '', state: 'interrupted',
      }),
    ]))

    expect(nodes).toMatchObject([{
      kind: 'voice-utterance',
      visibility: 'hidden',
      data: { utteranceId: noiseId, state: 'interrupted', text: '' },
    }])
  })

  it('hides a live empty utterance without blocking later realtime messages', () => {
    const noiseId = VoiceUtteranceId('live-noise')
    const assistantId = VoiceUtteranceId('assistant-after-noise')
    const value = assembler([
      at(1, 'voice/utterance-start', { utteranceId: noiseId, role: 'user' }),
    ])
    expect(chatNodes(value)[0]).toMatchObject({
      visibility: 'visible',
      data: { utteranceId: noiseId, state: 'streaming' },
    })

    value.append(at(2, 'voice/utterance-end', {
      utteranceId: noiseId, role: 'user', text: '', state: 'interrupted',
    }))
    expect(() => { value.flush() }).not.toThrow()
    expect(chatNodes(value)[0]).toMatchObject({
      visibility: 'hidden',
      data: { utteranceId: noiseId, state: 'interrupted' },
    })

    value.append(at(3, 'voice/utterance-start', { utteranceId: assistantId, role: 'assistant' }))
    value.append(at(4, 'voice/utterance-end', {
      utteranceId: assistantId, role: 'assistant', text: '后续消息正常显示', state: 'completed',
    }))
    value.flush()
    expect(chatNodes(value).at(-1)).toMatchObject({
      visibility: 'visible',
      data: { utteranceId: assistantId, text: '后续消息正常显示', state: 'completed' },
    })
  })

  it('keeps update-only tails pending until their starts are prepended', () => {
    const value = assembler([events[1]!], true)
    expect(chatNodes(value)).toHaveLength(0)
    value.prepend([events[0]!], false)
    value.flush()
    expect(chatNodes(value)).toEqual(chatNodes(assembler(events.slice(0, 2))))
  })

  it('rejects mismatched direct start calls and ignores unrelated updates', () => {
    const update = {
      ...events[1]!,
      role: 'start' as const,
      location: { kind: 'unresolved' as const },
    }
    const context = {
      key: 'voice-utterance:utterance-1', kind: 'voice-utterance', id: 'utterance-1',
      matches: [update], start: update, state: undefined, current: new Map(),
    }
    const reader = { previous: () => undefined }
    expect(() => voiceUtteranceDefinition.start(context, update, reader))
      .toThrow('voice utterance start requires voice/utterance-start')
    expect(() => voiceDelegationDefinition.start(context, update, reader))
      .toThrow('voice delegation start requires voice/task-delegated')

    const utteranceStart = {
      ...events[0]!, role: 'start' as const, location: { kind: 'unresolved' as const },
    }
    const utteranceState = voiceUtteranceDefinition.start({
      ...context, matches: [utteranceStart], start: utteranceStart,
    }, utteranceStart, reader)
    const unrelated = {
      ...at(20, 'turn/start', { turn: 1 }),
      role: 'update' as const,
      location: { kind: 'unresolved' as const },
    }
    expect(voiceUtteranceDefinition.update({
      ...context, matches: [utteranceStart], start: utteranceStart, state: utteranceState,
    }, unrelated)).toBe(utteranceState)
    expect(voiceUtteranceDefinition.buildViewNode?.({
      ...context, matches: [], start: undefined,
    })).toBeNull()

    const delegationStart = {
      ...events[2]!, role: 'start' as const, location: { kind: 'unresolved' as const },
    }
    const delegationState = voiceDelegationDefinition.start({
      ...context, matches: [delegationStart], start: delegationStart,
    }, delegationStart, reader)
    expect(voiceDelegationDefinition.update({
      ...context, matches: [delegationStart], start: delegationStart, state: delegationState,
    }, unrelated)).toBe(delegationState)
    expect(voiceDelegationDefinition.buildViewNode?.({
      ...context, matches: [], start: undefined,
    })).toBeNull()
    expect(voiceUtteranceDefinition.match(unrelated.event)).toBeNull()
    expect(voiceDelegationDefinition.match(unrelated.event)).toBeNull()
  })

  it('selects and retains each available task update form', () => {
    const value = assembler([
      at(1, 'voice/task-delegated', { taskId, taskSessionId: TASK_SESSION, input: '检查构建' }),
      at(2, 'voice/task-observation', { taskId, status: 'accepted' }),
      at(3, 'voice/task-observation', { taskId, status: 'failed', reason: '构建失败' }),
      at(4, 'voice/task-observation', { taskId, status: 'running' }),
    ])
    expect(chatNodes(value)[0]).toMatchObject({
      data: { status: 'running', update: '构建失败' },
    })
  })
})

function voiceSnapshot(overrides: Partial<VoiceClientSnapshot> = {}): VoiceClientSnapshot {
  return { state: 'off', inputMuted: false, textById: {}, ...overrides }
}

function listState(ids: SessionId[] = [VOICE_SESSION]): SessionListState {
  return {
    ids,
    byId: Object.fromEntries(ids.map(id => [id, {
      id, displayTitle: String(id), running: false, blank: false, updatedAt: 0,
    }])),
    current: VOICE_SESSION,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function workspaceState(): WorkspaceListState {
  return {
    items: [{
      workspaceId: 'workspace-1' as WorkspaceId,
      path: '/repo',
      title: 'repo',
      sessionIds: [VOICE_SESSION],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: 'workspace-1' as WorkspaceId,
  } as WorkspaceListState
}

function runtimeProps() {
  return {
    sessionId: VOICE_SESSION,
    useSession: vi.fn(),
    useProjection: vi.fn(),
    useInput: vi.fn(),
    inputActions: {},
    useSessions: (selector: (state: SessionListState) => unknown) => selector(listState()),
    useWorkspaces: (selector: (state: WorkspaceListState) => unknown) => selector(workspaceState()),
    t: zhT,
  }
}

describe('Voice UI surfaces', () => {
  it('uses the same compact Chinese relative-time labels as the Host', () => {
    const now = 10_000_000
    expect(relativeTimeLabel(now - 36 * 60_000, now, 'zh-CN')).toBe('36分钟')
    expect(relativeTimeLabel(now - 35 * 60_000, now, 'zh-CN')).not.toContain('前')
  })

  it('shows live utterance deltas, then prefers durable terminal text', () => {
    const id = VoiceUtteranceId('utterance-live')
    const runningNode = {
      key: 'voice-utterance:utterance-live', kind: 'voice-utterance', id: String(id), target: 'chat',
      anchorSeq: 1, location: { kind: 'unresolved' }, visibility: 'visible',
      data: { utteranceId: id, role: 'user', state: 'streaming' },
    } as VoiceUtteranceViewProps['node']
    const props = {
      ...runtimeProps(),
      node: runningNode,
      useVoice: (selector: (snapshot: VoiceClientSnapshot) => unknown) => selector(voiceSnapshot({
        sessionId: VOICE_SESSION,
        textById: { [id]: { text: '实时转写' } },
      })),
    } as unknown as VoiceUtteranceViewProps
    const view = render(<VoiceUtteranceView {...props} />)
    expect(screen.getByText('实时转写')).toBeTruthy()
    expect(screen.getByText('VOICE')).toBeTruthy()
    view.rerender(<VoiceUtteranceView {...props} node={{
      ...runningNode,
      data: { ...runningNode.data, text: '最终文本', state: 'interrupted' },
    }} />)
    expect(screen.getByText('最终文本')).toBeTruthy()
    expect(screen.getByText('已打断')).toBeTruthy()

    view.rerender(<VoiceUtteranceView
      {...props}
      node={{ ...runningNode, data: { ...runningNode.data, role: 'user' } }}
      useVoice={selector => selector(voiceSnapshot({ sessionId: VOICE_SESSION }))}
    />)
    expect(screen.getByText('正在聆听…')).toBeTruthy()
    view.rerender(<VoiceUtteranceView
      {...props}
      node={{ ...runningNode, data: { ...runningNode.data, role: 'assistant' } }}
      useVoice={selector => selector(voiceSnapshot({ sessionId: TASK_SESSION }))}
    />)
    expect(screen.getByText('正在生成语音回复…')).toBeTruthy()
  })

  it('enables delegated-task navigation only after the target Session is listed', () => {
    const openSession = vi.fn()
    const cancelTask = vi.fn()
    const node = {
      key: 'voice-delegation:task-1', kind: 'voice-delegation', id: 'task-1', target: 'chat',
      anchorSeq: 1, location: { kind: 'unresolved' }, visibility: 'visible',
      data: {
        taskId: VoiceTaskId('task-1'), taskSessionId: TASK_SESSION,
        input: '检查构建', status: 'running', update: '正在执行',
      },
    } as VoiceDelegationViewProps['node']
    const absent = {
      ...runtimeProps(), node, openSession,
      cancelTask,
      useVoice: (selector: (snapshot: VoiceClientSnapshot) => unknown) => selector(voiceSnapshot({
        state: 'listening', sessionId: VOICE_SESSION,
      })),
      useSessions: (selector: (state: SessionListState) => unknown) => selector(listState()),
    } as unknown as VoiceDelegationViewProps
    const view = render(<VoiceDelegationView {...absent} />)
    expect(screen.queryByText('正在执行')).toBeNull()
    expect(screen.getByText('后台处理')).toBeTruthy()
    expect(screen.getByText('执行中')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull()
    expect(screen.queryByRole('button', { name: '查看后台详情' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开后台处理详情' }))
    expect(screen.getByText('检查构建')).toBeTruthy()
    expect(screen.getByText('正在执行')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消任务' }))
    expect(cancelTask).toHaveBeenCalledWith('task-1')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '查看后台详情' }).disabled).toBe(true)
    const nestedState = listState()
    nestedState.subagentsByParent = {
      [VOICE_SESSION]: { entries: [{ kind: 'child', id: TASK_SESSION }] },
    } as typeof nestedState.subagentsByParent
    view.rerender(<VoiceDelegationView {...absent} useSessions={selector => selector(nestedState)} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '查看后台详情' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '查看后台详情' }))
    expect(openSession).toHaveBeenCalledWith(TASK_SESSION)
    view.rerender(<VoiceDelegationView
      {...absent}
      useSessions={selector => selector(nestedState)}
      useWorkspaces={selector => selector({ ...workspaceState(), archivedSessionIds: [VOICE_SESSION] })}
    />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '查看后台详情' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '查看后台详情' }))
    expect(openSession).toHaveBeenCalledTimes(1)
    view.rerender(<VoiceDelegationView {...absent} useSessions={selector => selector(listState([
      VOICE_SESSION, TASK_SESSION,
    ]))} />)
    fireEvent.click(screen.getByRole('button', { name: '查看后台详情' }))
    expect(openSession).toHaveBeenCalledWith(TASK_SESSION)
    fireEvent.click(screen.getByRole('button', { name: '收起后台处理详情' }))
    expect(screen.queryByText('正在执行')).toBeNull()
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull()
    expect(screen.queryByRole('button', { name: '查看后台详情' })).toBeNull()

    for (const status of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
      view.rerender(<VoiceDelegationView
        {...absent}
        node={{ ...node, data: { ...node.data, status } }}
      />)
      expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull()
    }
  })

  it('renders expandable delegated children beneath a Voice Session row', async () => {
    const openSession = vi.fn()
    const refreshSubagents = vi.fn()
    const setSubagentCatalogOpen = vi.fn()
    const state = listState()
    state.subagentsByParent = {
      [VOICE_SESSION]: {
        entries: [{ kind: 'child', id: TASK_SESSION, mode: 'continuable', label: '查看项目文件', activity: 'inactive', hasChildren: false }],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
    }
    const history = {
      entries: [{ sessionId: VOICE_SESSION, lastActiveAt: 1 }],
      taskActivity: [{ sessionId: TASK_SESSION, lastActiveAt: 2 }],
    }
    const view = render(<>
      <div role="tree">
        {[<div key={VOICE_SESSION} role="treeitem" className="sessionRow"><span className="title">语音会话</span></div>]}
      </div>
      <VoiceSessionMarkers
        {...runtimeProps() as unknown as never}
        useSessions={selector => selector(state)}
        useVoiceHistory={selector => selector(history)}
        openSession={openSession}
        refreshSubagents={refreshSubagents}
        setSubagentCatalogOpen={setSubagentCatalogOpen}
      />
    </>)
    await waitFor(() => { expect(screen.getByRole('button', { name: '展开语音子会话' })).toBeTruthy() })
    expect(refreshSubagents).toHaveBeenCalledWith(VOICE_SESSION)
    fireEvent.click(screen.getByRole('button', { name: '展开语音子会话' }))
    expect(setSubagentCatalogOpen).toHaveBeenCalledWith(VOICE_SESSION, true)
    const child = document.querySelector<HTMLElement>('[data-voice-subagent-child]')
    expect(child?.querySelector('[class*="childLabel"]')?.textContent).toBe('查看项目文件')
    expect(child?.getAttribute('title')).toBeNull()
    expect(child?.querySelector('[data-voice-subagent-child-time]')).toBeTruthy()
    const hostHover = vi.fn()
    document.querySelector<HTMLElement>('.sessionRow')?.addEventListener('mouseover', hostHover)
    fireEvent.mouseOver(child!)
    expect(hostHover).not.toHaveBeenCalled()
    const menuTrigger = screen.getByRole('button', { name: '会话“查看项目文件”的操作' })
    fireEvent.click(menuTrigger)
    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '分叉会话' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '归档会话' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '删除会话' })).toBeNull()
    expect(menuTrigger.getAttribute('title')).toBeNull()
    expect(child?.querySelector('[data-voice-subagent-child-time]')?.getAttribute('data-updated-at')).toBe('2')
    expect(child?.getAttribute('data-menu-open')).toBe('true')
    fireEvent.click(menuTrigger)
    fireEvent.click(child!)
    expect(openSession).toHaveBeenCalledWith(TASK_SESSION)
  })

  it('adds archive-manager deletion only when its public RPC capability is supplied', async () => {
    const openSession = vi.fn()
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    const state = listState()
    state.subagentsByParent = {
      [VOICE_SESSION]: {
        entries: [{ kind: 'child', id: TASK_SESSION, mode: 'continuable', label: '待删除任务' }],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
    } as typeof state.subagentsByParent
    render(<>
      <div role="tree"><div key={VOICE_SESSION} role="treeitem" className="sessionRow"><span className="title">语音会话</span></div></div>
      <VoiceSessionMarkers
        {...runtimeProps() as unknown as never}
        useSessions={selector => selector(state)}
        useVoiceHistory={selector => selector({ entries: [{ sessionId: VOICE_SESSION, lastActiveAt: 1 }] })}
        openSession={openSession}
        childActions={{ delete: deleteSession }}
        refreshSubagents={vi.fn()}
        setSubagentCatalogOpen={vi.fn()}
      />
    </>)
    await waitFor(() => { expect(screen.getByRole('button', { name: '展开语音子会话' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '展开语音子会话' }))
    fireEvent.click(screen.getByRole('button', { name: '会话“待删除任务”的操作' }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
    expect(screen.queryByRole('menuitem', { name: '归档会话' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }))
    expect(screen.getByRole('dialog', { name: '删除会话' })).toBeTruthy()
    expect(screen.getByText('将永久删除会话“待删除任务”及其子代理（含正在运行的）和全部记录（对话内容、统计、缓存），此操作不可恢复。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }))
    await waitFor(() => { expect(deleteSession).toHaveBeenCalledWith(TASK_SESSION, '待删除任务') })
  })

  it('shows an official error dialog when forking a delegated child fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const forkSession = vi.fn().mockRejectedValue(new Error('session fork unavailable'))
    const state = listState()
    state.subagentsByParent = {
      [VOICE_SESSION]: {
        entries: [{ kind: 'child', id: TASK_SESSION, mode: 'one-shot', label: '待分叉任务' }],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
    } as typeof state.subagentsByParent
    render(<>
      <div role="tree"><div key={VOICE_SESSION} role="treeitem" className="sessionRow"><span className="title">语音会话</span></div></div>
      <VoiceSessionMarkers
        {...runtimeProps() as unknown as never}
        useSessions={selector => selector(state)}
        useVoiceHistory={selector => selector({ entries: [{ sessionId: VOICE_SESSION, lastActiveAt: 1 }] })}
        openSession={vi.fn()}
        childActions={{ fork: forkSession }}
        refreshSubagents={vi.fn()}
        setSubagentCatalogOpen={vi.fn()}
      />
    </>)
    await waitFor(() => { expect(screen.getByRole('button', { name: '展开语音子会话' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '展开语音子会话' }))
    fireEvent.click(screen.getByRole('button', { name: '会话“待分叉任务”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分叉会话' }))
    await waitFor(() => { expect(forkSession).toHaveBeenCalledWith(TASK_SESSION) })
    expect(screen.getByRole('dialog', { name: '会话操作失败' })).toBeTruthy()
    expect(screen.getByText('session fork unavailable')).toBeTruthy()
  })

  it('hides children recorded in the shared workspace archive set', async () => {
    const state = listState()
    state.subagentsByParent = {
      [VOICE_SESSION]: {
        entries: [{ kind: 'child', id: TASK_SESSION, mode: 'one-shot', label: '已归档任务' }],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
    } as typeof state.subagentsByParent
    render(<>
      <div role="tree"><div key={VOICE_SESSION} role="treeitem" className="sessionRow"><span className="title">语音会话</span></div></div>
      <VoiceSessionMarkers
        {...runtimeProps() as unknown as never}
        useSessions={selector => selector(state)}
        useWorkspaces={selector => selector({ ...workspaceState(), archivedSessionIds: [TASK_SESSION] })}
        useVoiceHistory={selector => selector({ entries: [{ sessionId: VOICE_SESSION, lastActiveAt: 1 }] })}
        openSession={vi.fn()}
        refreshSubagents={vi.fn()}
        setSubagentCatalogOpen={vi.fn()}
      />
    </>)
    await waitFor(() => { expect(screen.getByRole('button', { name: '展开语音子会话' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '展开语音子会话' }))
    expect(document.querySelector('[data-voice-subagent-child]')).toBeNull()
  })

  it('hides children when their Voice parent is archived', async () => {
    const state = listState()
    state.subagentsByParent = {
      [VOICE_SESSION]: {
        entries: [{ kind: 'child', id: TASK_SESSION, mode: 'one-shot', label: '父会话已归档' }],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
    } as typeof state.subagentsByParent
    const view = render(<>
      <div role="tree"><div key={VOICE_SESSION} role="treeitem" className="sessionRow"><span className="title">语音会话</span></div></div>
      <VoiceSessionMarkers
        {...runtimeProps() as unknown as never}
        useSessions={selector => selector(state)}
        useWorkspaces={selector => selector({ ...workspaceState(), archivedSessionIds: [VOICE_SESSION] })}
        useVoiceHistory={selector => selector({ entries: [{ sessionId: VOICE_SESSION, lastActiveAt: 1 }] })}
        openSession={vi.fn()}
        refreshSubagents={vi.fn()}
        setSubagentCatalogOpen={vi.fn()}
      />
    </>)
    await waitFor(() => { expect(screen.getByRole('button', { name: '展开语音子会话' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '展开语音子会话' }))
    expect(document.querySelector('[data-voice-subagent-child]')).toBeNull()
    view.rerender(<>
      <div role="tree"><div key={VOICE_SESSION} role="treeitem" className="sessionRow"><span className="title">语音会话</span></div></div>
      <VoiceSessionMarkers
        {...runtimeProps() as unknown as never}
        useSessions={selector => selector(state)}
        useVoiceHistory={selector => selector({ entries: [{ sessionId: VOICE_SESSION, lastActiveAt: 1 }] })}
        openSession={vi.fn()}
        refreshSubagents={vi.fn()}
        setSubagentCatalogOpen={vi.fn()}
      />
    </>)
    await waitFor(() => { expect(document.querySelector('[data-voice-subagent-child]')).not.toBeNull() })
  })

  it('walks archived state through parent summaries and fallback navigation', () => {
    expect(isSessionEffectivelyArchived(
      TASK_SESSION,
      [VOICE_SESSION],
      { [TASK_SESSION]: {}, [VOICE_SESSION]: {} },
      id => id === TASK_SESSION ? VOICE_SESSION : undefined,
    )).toBe(true)
    expect(isSessionEffectivelyArchived(
      TASK_SESSION,
      [VOICE_SESSION],
      { [TASK_SESSION]: { parentId: VOICE_SESSION } },
    )).toBe(true)
  })

  it('shows a child last-activity time using the Host relative-time buckets', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000_000)
    const state = listState()
    state.subagentsByParent = {
      [VOICE_SESSION]: {
        entries: [{
          kind: 'child', id: TASK_SESSION, mode: 'continuable', label: '查看项目文件',
          activity: 'inactive', hasChildren: false, updatedAt: 10_000_000 - 30 * 60_000,
        }],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
    } as typeof state.subagentsByParent
    render(<>
      <div role="tree"><div key={VOICE_SESSION} role="treeitem" className="sessionRow"><span className="title">语音会话</span></div></div>
      <VoiceSessionMarkers
        {...runtimeProps() as unknown as never}
        useSessions={selector => selector(state)}
        useVoiceHistory={selector => selector({ entries: [{ sessionId: VOICE_SESSION, lastActiveAt: 1 }] })}
        openSession={vi.fn()}
        refreshSubagents={vi.fn()}
        setSubagentCatalogOpen={vi.fn()}
      />
    </>)
    await waitFor(() => { expect(screen.getByRole('button', { name: '展开语音子会话' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '展开语音子会话' }))
    expect(document.querySelector('[data-voice-subagent-child-time]')?.textContent).toBe('30min')
  })

  it('keeps the disclosure control visible while the child catalog is still absent', async () => {
    const refreshSubagents = vi.fn()
    const setSubagentCatalogOpen = vi.fn()
    const state = listState()
    const history = { entries: [{ sessionId: VOICE_SESSION, lastActiveAt: 1 }] }
    render(<>
      <div role="tree">
        <div key={VOICE_SESSION} role="treeitem" className="sessionRow"><span className="title">语音会话</span></div>
      </div>
      <VoiceSessionMarkers
        {...runtimeProps() as unknown as never}
        useSessions={selector => selector(state)}
        useVoiceHistory={selector => selector(history)}
        openSession={vi.fn()}
        refreshSubagents={refreshSubagents}
        setSubagentCatalogOpen={setSubagentCatalogOpen}
      />
    </>)
    await waitFor(() => { expect(screen.getByRole('button', { name: '展开语音子会话' })).toBeTruthy() })
    expect(refreshSubagents).toHaveBeenCalledWith(VOICE_SESSION)
    fireEvent.click(screen.getByRole('button', { name: '展开语音子会话' }))
    expect(setSubagentCatalogOpen).toHaveBeenCalledWith(VOICE_SESSION, true)
  })

  it('keeps unavailable catalog rows visible without navigating them', async () => {
    const openSession = vi.fn()
    const state = listState()
    state.subagentsByParent = {
      [VOICE_SESSION]: {
        entries: [{ kind: 'broken', id: TASK_SESSION, mode: 'one-shot', label: '会话记录损坏', hasChildren: false }],
        parentAvailable: true,
        state: 'ready',
        error: null,
      },
    } as typeof state.subagentsByParent
    const history = { entries: [{ sessionId: VOICE_SESSION, lastActiveAt: 1 }] }
    render(<>
      <div role="tree"><div key={VOICE_SESSION} role="treeitem" className="sessionRow"><span className="title">语音会话</span></div></div>
      <VoiceSessionMarkers
        {...runtimeProps() as unknown as never}
        useSessions={selector => selector(state)}
        useVoiceHistory={selector => selector(history)}
        openSession={openSession}
        refreshSubagents={vi.fn()}
        setSubagentCatalogOpen={vi.fn()}
      />
    </>)
    await waitFor(() => { expect(screen.getByRole('button', { name: '展开语音子会话' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '展开语音子会话' }))
    const child = document.querySelector<HTMLButtonElement>('[data-voice-subagent-child]')
    expect(child?.textContent).toBe('会话记录损坏')
    expect(child?.disabled).toBe(true)
    fireEvent.click(child!)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('attaches Voice Mode to the current Session and controls the active transport', () => {
    const startVoice = vi.fn().mockResolvedValue(undefined)
    const retryVoice = vi.fn().mockResolvedValue(undefined)
    const interruptResponse = vi.fn()
    const setVoiceMuted = vi.fn()
    const base = {
      ...runtimeProps(),
      useSessions: (selector: (state: SessionListState) => unknown) => selector({
        ...listState(),
        byId: {
          [VOICE_SESSION]: {
            id: VOICE_SESSION, displayTitle: 'voice', running: false, blank: false,
            updatedAt: 0, cwd: '/repo', agentPreset: 'voice',
          },
        },
      }),
      useVoice: (selector: (snapshot: VoiceClientSnapshot) => unknown) => selector(voiceSnapshot()),
      startVoice, retryVoice, interruptResponse, setVoiceMuted,
    } as unknown as VoiceControlProps
    const view = render(<VoiceControl {...base} />)
    fireEvent.click(screen.getByRole('button', { name: '开始语音对话' }))
    expect(startVoice).toHaveBeenCalledWith(VOICE_SESSION)
    expect(screen.queryByRole('button', { name: '打断播放' })).toBeNull()

    for (const state of ['connecting', 'listening'] as const) {
      view.rerender(<VoiceControl {...base} useVoice={selector => selector(voiceSnapshot({ state }))} />)
      expect(screen.queryByRole('button', { name: '打断播放' })).toBeNull()
    }

    view.rerender(<VoiceControl {...base} useVoice={selector => selector(voiceSnapshot({ state: 'speaking' }))} />)
    const interrupt = screen.getByRole('button', { name: '打断播放' })
    expect(interrupt).toBeTruthy()
    fireEvent.click(interrupt)
    expect(interruptResponse).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '静音麦克风' }))
    expect(setVoiceMuted).toHaveBeenLastCalledWith(true)

    view.rerender(<VoiceControl {...base} useVoice={selector => selector(voiceSnapshot({
      state: 'speaking', inputMuted: true,
    }))} />)
    const muted = screen.getByRole('button', { name: '解除静音' })
    expect(muted.getAttribute('data-muted')).toBe('true')
    fireEvent.click(muted)
    expect(setVoiceMuted).toHaveBeenLastCalledWith(false)

    view.rerender(<VoiceControl {...base} useVoice={selector => selector(voiceSnapshot({
      state: 'error', sessionId: VOICE_SESSION,
    }))} />)
    expect(screen.queryByRole('button', { name: '打断播放' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '语音连接失败，点击重试' }))
    expect(retryVoice).toHaveBeenCalledTimes(1)

    view.rerender(<VoiceControl
      {...base}
      useSessions={selector => selector({ ...listState(), byId: {} })}
      useWorkspaces={selector => selector({ ...workspaceState(), items: [] })}
      useVoice={selector => selector(voiceSnapshot({ state: 'error' }))}
    />)
    fireEvent.click(screen.getByRole('button', { name: '语音连接失败，点击重试' }))
    expect(startVoice).toHaveBeenLastCalledWith(VOICE_SESSION)
  })

  it('renders the same surfaces through the English dictionary', () => {
    const startVoice = vi.fn().mockResolvedValue(undefined)
    render(<VoiceControl {...(runtimeProps() as unknown as VoiceControlProps)} t={enT}
      useVoice={selector => selector(voiceSnapshot())}
      startVoice={startVoice}
      retryVoice={vi.fn().mockResolvedValue(undefined)}
      interruptResponse={vi.fn()}
      setVoiceMuted={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Start voice conversation' }))
    expect(startVoice).toHaveBeenCalledTimes(1)
    expect(Object.keys(en)).toEqual(Object.keys(zh))
  })

  it('keeps the stop action in the root overlay', () => {
    const stopVoice = vi.fn().mockResolvedValue(undefined)
    const props = {
      useVoice: (selector: (snapshot: VoiceClientSnapshot) => unknown) => selector(voiceSnapshot({
        state: 'listening', sessionId: VOICE_SESSION,
      })),
      useWorkspaces: vi.fn(),
      stopVoice,
      t: zhT,
    } as unknown as VoiceOverlayProps
    const view = render(<VoiceOverlay {...props} />)
    expect(screen.getByText('正在聆听')).toBeTruthy()
    expect(screen.queryByText('已静音')).toBeNull()
    expect(screen.queryByRole('button', { name: '返回语音对话' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '结束' }))
    expect(stopVoice).toHaveBeenCalledTimes(1)
    view.rerender(<VoiceOverlay {...props} useVoice={selector => selector(voiceSnapshot({
      state: 'speaking', sessionId: VOICE_SESSION, inputMuted: true,
    }))} />)
    expect(screen.getByText('已静音')).toBeTruthy()
    expect(screen.queryByText('正在播放回复')).toBeNull()
    view.rerender(<VoiceOverlay {...props} useVoice={selector => selector(voiceSnapshot({ state: 'error' }))} />)
    expect(screen.getByText('语音连接失败')).toBeTruthy()
    view.rerender(<VoiceOverlay {...props} useVoice={selector => selector(voiceSnapshot())} />)
    expect(screen.queryByText('正在聆听')).toBeNull()
  })
})

describe('Voice UI assembly', () => {
  it('registers every seat and binds the current session, navigation, retry, stop, and teardown', async () => {
    const registrations: { options: Record<string, unknown>; component: unknown }[] = []
    const definitions: ConversationNodeDefinition[] = []
    const effects: (() => unknown)[] = []
    const unregisterLocale = vi.fn()
    const registerLocale = vi.fn().mockReturnValue(unregisterLocale)
    const open = vi.fn()
    const openSubagent = vi.fn()
    let archivedSessionIds: SessionId[] = []
    const refreshSubagents = vi.fn().mockResolvedValue(undefined)
    const deleteSession = vi.fn().mockResolvedValue({ ok: true, value: { deleted: true } })
    const subagentAddress = vi.fn((id: SessionId) => id === TASK_SESSION
      ? { parentSessionId: VOICE_SESSION, childSessionId: TASK_SESSION, mode: 'continuable' as const }
      : undefined)
    const connectWorkspace = vi.fn().mockResolvedValue(FRESH_VOICE_SESSION)
    const start = vi.spyOn(VoiceController.prototype, 'start').mockResolvedValue(undefined)
    const stop = vi.spyOn(VoiceController.prototype, 'stop').mockResolvedValue(undefined)
    const retry = vi.spyOn(VoiceController.prototype, 'retry').mockResolvedValue(undefined)
    const setInputMuted = vi.spyOn(VoiceController.prototype, 'setInputMuted').mockImplementation(() => undefined)
    const input = {
      state: { getSnapshot: () => ({ draft: '', imageIds: [] }) },
      setDraft: vi.fn(), submit: vi.fn(), notify: vi.fn(),
    }
    const ctx = {
      get: (key: string) => key === 'remote.workspaceRegistry' ? { deleteSession } : undefined,
      sessions: {
        open, openSubagent, subagentAddress, navigationAddress: subagentAddress, refreshSubagents,
        scope: () => ({}), list: { getSnapshot: () => listState() },
      },
      conversation: { input: { for: () => input } },
      workspaces: { list: { getSnapshot: () => ({ ...workspaceState(), archivedSessionIds }) }, connectWorkspace },
      locale: { register: registerLocale },
      conversationEvents: { register: (definition: ConversationNodeDefinition) => { definitions.push(definition) } },
      effect: (factory: () => unknown) => { effects.push(factory) },
      slots: {
        inject: (_name: string, factory: () => unknown) => { factory() },
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    } as unknown as ClientContext

    expect(inject).toEqual(['conversation', 'conversationEvents', 'slots', 'sessions', 'workspaces', 'locale', 'remote'])
    apply(ctx)
    expect(definitions).toEqual([voiceUtteranceDefinition, voiceDelegationDefinition])
    expect(registrations.map(entry => [entry.options.name, entry.options.id ?? entry.options.key])).toEqual([
      ['conversation.input.right', 'voice'],
      ['shell.overlay', 'voice-active'],
      ['shell.overlay', 'voice-session-markers'],
      ['conversation.chat.node', 'voice-utterance'],
      ['conversation.chat.node', 'voice-delegation'],
    ])
    expect(registrations.every(entry => entry.options.locale === NS)).toBe(true)

    const control = (registrations[0]!.options.inject as () => {
      hooks: { voice: VoiceController }
      startVoice(sessionId: SessionId): Promise<void>
      retryVoice(): Promise<void>
      setVoiceMuted(muted: boolean): void
    })()
    await control.startVoice(VOICE_SESSION)
    expect(connectWorkspace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith(VOICE_SESSION)
    expect(start).toHaveBeenCalledWith(VOICE_SESSION)
    await control.retryVoice()
    control.setVoiceMuted(true)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(setInputMuted).toHaveBeenCalledWith(true)
    vi.spyOn(control.hooks.voice, 'getSnapshot').mockReturnValue(voiceSnapshot({
      state: 'listening', sessionId: VOICE_SESSION,
    }))
    await control.retryVoice()
    expect(retry).toHaveBeenCalledTimes(2)

    const overlay = (registrations[1]!.options.inject as () => { stopVoice(): Promise<void> })()
    await overlay.stopVoice()
    const markers = (registrations[2]!.options.inject as () => {
      childActions?: {
        delete?: (id: SessionId, title: string) => Promise<void>
      }
    })()
    expect(markers.childActions).not.toHaveProperty('archive')
    expect(markers.childActions?.delete).toBeTypeOf('function')
    await markers.childActions!.delete!(TASK_SESSION, 'task')
    expect(deleteSession).toHaveBeenCalledWith(TASK_SESSION)
    expect(refreshSubagents).toHaveBeenCalledWith(VOICE_SESSION)
    const utterance = (registrations[3]!.options.inject as () => { hooks: { voice: unknown } })()
    expect(utterance.hooks.voice).toBeInstanceOf(VoiceController)
    const delegation = (registrations[4]!.options.inject as () => { openSession(id: SessionId): void })()
    delegation.openSession(TASK_SESSION)
    expect(openSubagent).toHaveBeenLastCalledWith({
      parentSessionId: VOICE_SESSION,
      childSessionId: TASK_SESSION,
      mode: 'continuable',
    })
    archivedSessionIds = [VOICE_SESSION]
    delegation.openSession(TASK_SESSION)
    expect(openSubagent).toHaveBeenCalledTimes(1)

    const disposeLocale = effects[0]!() as () => void
    expect(registerLocale).toHaveBeenCalledWith(NS, { zh, en })
    disposeLocale()
    expect(unregisterLocale).toHaveBeenCalledTimes(1)
    const dispose = effects[1]!() as () => Promise<void>
    await dispose()
    expect(stop.mock.calls.length).toBeGreaterThanOrEqual(2)
    const disposeTextSubmit = effects[2]!() as () => void
    disposeTextSubmit()
    const disposeHistory = effects[3]!() as () => void
    disposeHistory()
    const disposeModelSelectionCompatibility = effects[4]!() as () => void
    expect((ctx.sessions as unknown as { subagentAddress: (id: SessionId) => unknown }).subagentAddress(TASK_SESSION)).toBeUndefined()
    disposeModelSelectionCompatibility()
    expect((ctx.sessions as unknown as { subagentAddress: (id: SessionId) => unknown }).subagentAddress(TASK_SESSION)).toEqual({
      parentSessionId: VOICE_SESSION,
      childSessionId: TASK_SESSION,
      mode: 'continuable',
    })
  })

  it('starts voice from the source session even when it has no workspace', async () => {
    const registrations: { options: Record<string, unknown> }[] = []
    const connectWorkspace = vi.fn()
    const open = vi.fn()
    const source = listState()
    source.byId[VOICE_SESSION] = { ...source.byId[VOICE_SESSION]!, cwd: '/ungrouped' }
    const sessionSnapshot = source
    const start = vi.spyOn(VoiceController.prototype, 'start').mockResolvedValue(undefined)
    const input = {
      state: { getSnapshot: () => ({ draft: '', imageIds: [] }) },
      setDraft: vi.fn(), submit: vi.fn(), notify: vi.fn(),
    }
    const ctx = {
      sessions: { open, scope: () => ({}), list: { getSnapshot: () => sessionSnapshot } },
      conversation: { input: { for: () => input } },
      workspaces: {
        list: { getSnapshot: () => ({ ...workspaceState(), items: [] }) },
        connectWorkspace,
      },
      locale: { register: () => () => undefined },
      conversationEvents: { register: () => undefined },
      effect: () => undefined,
      slots: {
        inject: (_name: string, factory: () => unknown) => { factory() },
        register: (options: Record<string, unknown>) => {
          registrations.push({ options })
          return () => undefined
        },
      },
    } as unknown as ClientContext

    apply(ctx)
    const control = (registrations[0]!.options.inject as () => VoiceControlInjected)()
    await control.startVoice(VOICE_SESSION)
    expect(connectWorkspace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith(VOICE_SESSION)
    expect(start).toHaveBeenCalledWith(VOICE_SESSION)
  })
})
