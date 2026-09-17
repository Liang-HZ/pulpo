// 派活表单：渠道 + 任务 + 工作目录 + 模型 ID + 思考强度 + delivery 偏好。
//
// 模型与强度一律从目标渠道的 `agent/descriptor` 读——那是 agent 自己的自描述，
// 壳不建中心权威表，也不给默认值兜底：拿不到就如实说拿不到。

import { useMemo, useState } from "react";
import type { SteeringTier } from "../lib/protocol";
import type { AppState } from "../lib/store";
import { AppStore } from "../lib/store";
import { isTauri, pickDirectory } from "../platform";
import { Button, Field, inputClass, StateBlock } from "./ui";

interface Props {
  store: AppStore;
  state: AppState;
  onClose: () => void;
}

export function DelegateForm({ store, state, onClose }: Props) {
  const [agentId, setAgentId] = useState(state.agents[0]?.agentId ?? "");
  const [task, setTask] = useState("");
  const [cwd, setCwd] = useState(state.cwds[0] ?? "");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const [maxTier, setMaxTier] = useState<SteeringTier>("queue");
  const [allowInterrupt, setAllowInterrupt] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  const descriptor = state.agentDescriptors[agentId];
  const descriptorError = state.agentDescriptorError[agentId];
  const desktop = isTauri();

  const models = descriptor?.models ?? [];
  const selectedModel = useMemo(
    () => models.find((m) => m.id === (modelId || descriptor?.currentModelId)),
    [models, modelId, descriptor],
  );
  const efforts = selectedModel?.efforts ?? descriptor?.efforts ?? [];
  const effectiveModel = modelId || descriptor?.currentModelId || "";
  const effectiveEffort = effort || descriptor?.currentEffort || "";

  async function pick() {
    const picked = await pickDirectory();
    if (picked) setCwd(picked);
  }

  async function submit() {
    const next: Record<string, string> = {};
    if (!agentId) next.agentId = "先选一个渠道";
    if (!task.trim()) next.task = "任务描述不能为空";
    if (!cwd.trim()) next.cwd = "工作目录不能为空";
    else if (!cwd.startsWith("/")) next.cwd = "工作目录要填绝对路径";
    if (!effectiveModel) next.modelId = "拿不到这个渠道的模型清单，没法指定模型";
    setErrors(next);
    if (Object.keys(next).length) return;

    const taskId = await store.delegate({
      agentId,
      task: task.trim(),
      cwd: cwd.trim(),
      modelId: effectiveModel,
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      delivery: { maxTier, allowInterrupt },
    });
    if (taskId) {
      setDone(taskId);
      setTask("");
    }
  }

  return (
    <section
      aria-label="派活"
      className="flex max-h-[60%] shrink-0 flex-col gap-4 overflow-y-auto border-t border-border bg-surface px-4 py-4"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-h2 font-bold text-fg">派活</h2>
        <Button size="md" tone="ghost" onClick={onClose}>
          收起
        </Button>
      </header>

      {descriptorError ? (
        <StateBlock
          phase="error"
          title={`读不到 ${agentId} 的能力描述符`}
          hint={`${descriptorError}　模型清单与思考强度都来自 agent 在 session/new 时的自描述，没有活动会话就没有这些事实。先在左栏给这个渠道新建一条会话，再回来派活。`}
          action={
            <Button size="md" onClick={() => void store.refreshAgentDescriptor(agentId)}>
              重新读取
            </Button>
          }
        />
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        <Field label="渠道" required {...(errors.agentId ? { error: errors.agentId } : {})}>
          {({ id, describedBy }) => (
            <select
              id={id}
              aria-describedby={describedBy}
              aria-required="true"
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                setModelId("");
                setEffort("");
              }}
              className={`${inputClass()} h-6`}
            >
              {state.agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          label="工作目录"
          required
          {...(errors.cwd ? { error: errors.cwd } : {})}
          help={desktop ? undefined : "浏览器里没有目录对话框，直接填绝对路径。"}
        >
          {({ id, describedBy, invalid }) => (
            <div className="flex gap-2">
              <input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-required="true"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/绝对/路径"
                className={`${inputClass(invalid)} h-6 font-mono`}
              />
              {desktop ? (
                <Button size="md" onClick={() => void pick()}>
                  选择
                </Button>
              ) : null}
            </div>
          )}
        </Field>

        <Field
          label="模型 ID"
          required
          {...(errors.modelId ? { error: errors.modelId } : {})}
          help="原样是 agent 自己的写法，pulpo 不改写、不建映射。"
        >
          {({ id, describedBy, invalid }) => (
            <select
              id={id}
              data-testid="delegate-model"
              aria-describedby={describedBy}
              aria-required="true"
              aria-invalid={invalid || undefined}
              value={effectiveModel}
              disabled={models.length === 0}
              onChange={(e) => {
                setModelId(e.target.value);
                setEffort("");
              }}
              className={`${inputClass(invalid)} h-6`}
            >
              {models.length === 0 ? <option value="">（没有可选模型）</option> : null}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? m.id}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="思考强度" optional help="取自所选模型自报的可选项。">
          {({ id, describedBy }) => (
            <select
              id={id}
              data-testid="delegate-effort"
              aria-describedby={describedBy}
              value={effectiveEffort}
              disabled={efforts.length === 0}
              onChange={(e) => setEffort(e.target.value)}
              className={`${inputClass()} h-6`}
            >
              {efforts.length === 0 ? <option value="">（这个渠道没暴露）</option> : null}
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <Field label="任务" required {...(errors.task ? { error: errors.task } : {})}>
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            data-testid="delegate-task"
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            aria-required="true"
            rows={3}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="要它做什么…"
            className={`${inputClass(invalid)} resize-y py-2 text-body`}
          />
        )}
      </Field>

      <Field
        label="后续补充消息的投递偏好"
        optional
        help="只能往保守方向压——能力是 agent 说了算，壳不能把档位往上抬。"
      >
        {({ id, describedBy }) => (
          <div className="flex flex-wrap items-center gap-3">
            <select
              id={id}
              aria-describedby={describedBy}
              value={maxTier}
              onChange={(e) => setMaxTier(e.target.value as SteeringTier)}
              className={`${inputClass()} h-6 w-auto`}
            >
              {(["extension", "concurrent", "soft-interrupt", "queue"] as SteeringTier[]).map((t) => (
                <option key={t} value={t}>
                  最弱降到 {t}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-caption text-fg-muted">
              <input
                type="checkbox"
                checked={allowInterrupt}
                onChange={(e) => setAllowInterrupt(e.target.checked)}
                className="size-3 accent-[var(--color-brand)]"
              />
              允许软打断（会丢掉当前这一步已经跑的工作）
            </label>
          </div>
        )}
      </Field>

      <div className="flex items-center gap-3">
        <Button
          tone="primary"
          size="lg"
          data-testid="delegate-submit"
          loading={Boolean(state.busy.delegate)}
          onClick={() => void submit()}
        >
          派出去
        </Button>
        {done ? (
          <span className="text-caption text-success">已派出，右栏可以看它的状态</span>
        ) : null}
      </div>
    </section>
  );
}
