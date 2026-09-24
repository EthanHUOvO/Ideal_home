"use client";

import { useEffect, useMemo, useState } from "react";

export type GenerationStage = {
  label: string;
  detail?: string;
};

type Props = {
  title: string;
  stages: GenerationStage[];
  progress: number;
  elapsedSeconds: number;
  estimatedSeconds: number;
  allowFallback?: boolean;
  onUseFallback?: () => void;
  ready?: boolean;
  completeTitle?: string;
  completeDescription?: string;
  actionLabel?: string;
  onAction?: () => void;
  error?: string;
  preparing?: boolean;
  prepareRemainingSeconds?: number;
  maxProgress?: number;
  showTimeoutMessage?: boolean;
};

export default function GenerationProgressModal({
  title,
  stages,
  progress,
  elapsedSeconds,
  estimatedSeconds,
  allowFallback = false,
  onUseFallback,
  ready = false,
  completeTitle = "已经准备好了",
  completeDescription = "您的结果已经生成，可以继续查看。",
  actionLabel = "查看结果",
  onAction,
  error,
  preparing = false,
  prepareRemainingSeconds = 4,
  maxProgress = 92,
  showTimeoutMessage = true,
}: Props) {
  const [fallbackDismissed, setFallbackDismissed] = useState(false);
  useEffect(() => setFallbackDismissed(false), [title]);

  const safeProgress = Math.max(0, Math.min(maxProgress, Math.round(progress)));
  const activeIndex = useMemo(() => {
    if (!stages.length) return 0;
    if (ready) return stages.length - 1;
    return Math.min(stages.length - 1, Math.floor((safeProgress / 93) * stages.length));
  }, [ready, safeProgress, stages.length]);
  const showFallback = allowFallback && elapsedSeconds >= 60 && !ready && !error && !fallbackDismissed;
  const remaining = Math.max(0, estimatedSeconds - elapsedSeconds);
  const waitingMessage = showTimeoutMessage && elapsedSeconds >= 45
    ? "正在优化当前方案…"
    : showTimeoutMessage && elapsedSeconds >= 30
      ? "正在完成最后的空间检查…"
      : stages[activeIndex]?.detail || stages[activeIndex]?.label || "正在准备…";
  const waitingDetail = showTimeoutMessage && elapsedSeconds >= 45
    ? "网络状态可能影响生成速度，请稍候，我们正在继续处理。"
    : showTimeoutMessage && elapsedSeconds >= 30
      ? "复杂户型可能需要多一点时间，您的设计结果不会丢失。"
      : undefined;

  const preparationMessage = prepareRemainingSeconds >= 4
    ? "正在初始化三维场景…"
    : prepareRemainingSeconds >= 3
      ? "正在配置空间交互…"
      : prepareRemainingSeconds >= 2
        ? "正在准备漫游环境…"
        : "正在进入您的3D空间…";

  return (
    <div className="generation-progress-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <section className="generation-progress-modal">
        {error ? (
          <>
            <div className="generation-progress-state error">生成未完成</div>
            <h2>这次生成遇到了一点问题</h2>
            <p>{error}</p>
            {onAction && <button className="generation-primary-action" onClick={onAction}>返回重新尝试</button>}
          </>
        ) : preparing ? (
          <>
            <div className="generation-progress-state complete">生成完成</div>
            <h2>您的3D空间已创建完成</h2>
            <p>{preparationMessage}</p>
            <p className="generation-current-detail">正在完成场景初始化与交互配置。</p>
            <div className="generation-progress-track" aria-label="生成进度 100%">
              <span style={{ width: "100%" }} />
            </div>
            <strong className="generation-progress-value">100%</strong>
            <div className="generation-preparing-status">
              <p>✓ 户型结构解析完成</p>
              <p>✓ 三维空间构建完成</p>
              <p>✓ 门窗与空间关系完成</p>
              <p>✓ 场景细节优化完成</p>
              <small>预计还需 {Math.max(0, prepareRemainingSeconds)} 秒</small>
            </div>
          </>
        ) : ready ? (
          <>
            <div className="generation-progress-state complete">已完成</div>
            <h2>{completeTitle}</h2>
            <p>{completeDescription}</p>
            <div className="generation-progress-track" aria-label="生成进度 100%">
              <span style={{ width: "100%" }} />
            </div>
            <strong className="generation-progress-value">100%</strong>
            {onAction && <button className="generation-primary-action" onClick={onAction}>{actionLabel}</button>}
          </>
        ) : (
          <>
            <div className="generation-progress-state">智能生成中</div>
            <h2>{title}</h2>
            <p className="generation-current-stage">{waitingMessage}</p>
            {waitingDetail && <p className="generation-current-detail">{waitingDetail}</p>}
            <div className="generation-progress-track" aria-label={`生成进度 ${safeProgress}%`}>
              <span style={{ width: `${safeProgress}%` }} />
            </div>
            <div className="generation-progress-meta">
              <strong>{safeProgress}%</strong>
              <span>已用时 {elapsedSeconds} 秒</span>
              <span>{remaining > 0 ? `预计还需约 ${remaining} 秒` : "仍在处理，请稍候"}</span>
            </div>
            <ol className="generation-stage-list">
              {stages.map((stage, index) => (
                <li key={stage.label} className={index < activeIndex ? "done" : index === activeIndex ? "active" : ""}>
                  <i>{index < activeIndex ? "✓" : index + 1}</i>
                  <span>{stage.label}</span>
                </li>
              ))}
            </ol>
            {showFallback && (
              <div className="generation-fallback">
                <h3>本次在线生成时间较长</h3>
                <p>您可以继续等待，或者先查看系统为您准备的推荐3D方案。</p>
                <div>
                  <button className="ghost" onClick={() => setFallbackDismissed(true)}>继续等待</button>
                  <button onClick={onUseFallback}>先查看推荐方案</button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
