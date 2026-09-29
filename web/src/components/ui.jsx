import { Children, cloneElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useApp } from '../appStore.js';

// ================= Tooltip =================
// 所有按钮的提示统一用 <Tip>：悬停 0.35s 出现，连续划过相邻按钮时立即切换；
// 画布（时间轴）上的元素用 showTip(rect, ...) 复用同一个浮层。
const useTipStore = create(() => ({ tip: null }));
let showTimer = null;
let warmUntil = 0;

export function showTip(target, content, { keys, side = 'top', delay } = {}) {
  if (!content) return hideTip();
  const rect = target?.getBoundingClientRect ? target.getBoundingClientRect() : target;
  clearTimeout(showTimer);
  const open = () => useTipStore.setState({ tip: { content, keys, side, rect } });
  const d = Date.now() < warmUntil ? 0 : (delay ?? 350);
  if (d) showTimer = setTimeout(open, d);
  else open();
}

export function hideTip() {
  clearTimeout(showTimer);
  if (useTipStore.getState().tip) {
    warmUntil = Date.now() + 450;
    useTipStore.setState({ tip: null });
  }
}

const chain = (a, b) => (e) => {
  a?.(e);
  b(e);
};

export function Tip({ tip, keys, side, children }) {
  const child = Children.only(children);
  if (!tip) return child;
  const show = (e) => showTip(e.currentTarget, tip, { keys, side });
  const handlers = {
    onMouseEnter: chain(child.props.onMouseEnter, show),
    onMouseLeave: chain(child.props.onMouseLeave, hideTip),
    onMouseDown: chain(child.props.onMouseDown, hideTip),
    onFocus: chain(child.props.onFocus, (e) => e.currentTarget.matches?.(':focus-visible') && show(e)),
    onBlur: chain(child.props.onBlur, hideTip),
  };
  // 禁用的按钮不触发鼠标事件，包一层来接收悬停（顺便解释为什么不能点）
  if (child.props.disabled) {
    return (
      <span className="tip-wrap" onMouseEnter={handlers.onMouseEnter} onMouseLeave={handlers.onMouseLeave}>
        {child}
      </span>
    );
  }
  return cloneElement(child, {
    ...handlers,
    'aria-label': child.props['aria-label'] ?? (typeof tip === 'string' ? tip : undefined),
  });
}

export function Keys({ keys }) {
  return (
    <span className="keys">
      {keys.map((k, i) =>
        k === '/' ? (
          <span key={i} className="keys-sep">
            /
          </span>
        ) : (
          <kbd key={i}>{k}</kbd>
        ),
      )}
    </span>
  );
}

export function TooltipHost() {
  const tip = useTipStore((s) => s.tip);
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!tip || !ref.current) return setPos(null);
    const b = ref.current.getBoundingClientRect();
    const r = tip.rect;
    const gap = 8;
    let side = tip.side;
    let top = side === 'top' ? r.top - b.height - gap : r.bottom + gap;
    if (side === 'top' && top < 6) {
      side = 'bottom';
      top = r.bottom + gap;
    } else if (side === 'bottom' && top + b.height > window.innerHeight - 6) {
      side = 'top';
      top = r.top - b.height - gap;
    }
    const cx = r.left + r.width / 2;
    const left = Math.max(8, Math.min(window.innerWidth - b.width - 8, cx - b.width / 2));
    setPos({ top, left, side, arrow: Math.max(12, Math.min(b.width - 12, cx - left)) });
  }, [tip]);

  useEffect(() => {
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
    window.addEventListener('blur', hideTip);
    return () => {
      window.removeEventListener('scroll', hideTip, true);
      window.removeEventListener('resize', hideTip);
      window.removeEventListener('blur', hideTip);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      className={`tooltip ${pos ? `show ${pos.side}` : ''}`}
      style={pos ? { top: pos.top, left: pos.left, '--arrow': `${pos.arrow}px` } : { top: -9999, left: -9999 }}
      role="tooltip"
    >
      <span className="tip-text">{tip.content}</span>
      {tip.keys && <Keys keys={tip.keys} />}
    </div>,
    document.body,
  );
}

// ================= 弹窗 =================
// 点遮罩或按 Esc 都会调用 onClose（有未保存内容的弹窗在 onClose 里自行确认）
export function Modal({ title, icon, onClose, children, footer, wide, headerExtra }) {
  const maskRef = useRef(null);
  const downOnMask = useRef(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const masks = document.querySelectorAll('.modal-mask');
      if (masks[masks.length - 1] !== maskRef.current) return; // 只关最上层
      e.stopPropagation();
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => hideTip, []);
  return (
    <div
      ref={maskRef}
      className="modal-mask"
      onMouseDown={(e) => (downOnMask.current = e.target === e.currentTarget)}
      onMouseUp={(e) => {
        if (downOnMask.current && e.target === e.currentTarget) onClose?.();
        downOnMask.current = false;
      }}
    >
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog">
        <div className="modal-head">
          {icon}
          <h3>{title}</h3>
          {headerExtra}
          <div className="spacer" />
          {onClose && (
            <Tip tip="关闭" keys={['Esc']}>
              <button className="icon-btn sm" onClick={onClose}>
                <X />
              </button>
            </Tip>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`} onClick={() => dismiss(t.id)}>
          {t.type === 'error' ? <AlertCircle /> : t.type === 'success' ? <CheckCircle2 /> : <Info />}
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ---- 确认框（Promise 形式）----
const useConfirm = create(() => ({ dialog: null }));

export function confirmDialog(opts) {
  return new Promise((resolve) => {
    useConfirm.setState({ dialog: { ...opts, resolve } });
  });
}

export function ConfirmHost() {
  const dialog = useConfirm((s) => s.dialog);
  const [checked, setChecked] = useState(false);
  const [checks, setChecks] = useState({});
  useEffect(() => {
    setChecked(Boolean(dialog?.checkboxDefault));
    setChecks(Object.fromEntries((dialog?.checkboxes || []).map((c) => [c.key, Boolean(c.default)])));
  }, [dialog]);
  if (!dialog) return null;
  const close = (ok) => {
    useConfirm.setState({ dialog: null });
    dialog.resolve(ok ? (dialog.checkboxes ? { checks } : dialog.checkbox ? { checked } : true) : false);
  };
  return (
    <Modal
      title={dialog.title}
      onClose={() => close(false)}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={() => close(false)}>
            {dialog.cancelText || '取消'}
          </button>
          <button className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)} autoFocus>
            {dialog.okText || '确定'}
          </button>
        </>
      }
    >
      <div style={{ lineHeight: 1.7, color: 'var(--ink-2)' }}>{dialog.message}</div>
      {dialog.checkbox && (
        <label className="check" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {dialog.checkbox}
        </label>
      )}
      {dialog.checkboxes?.map((c, i) => (
        <label key={c.key} className="check" style={{ marginTop: i ? 8 : 14 }}>
          <input type="checkbox" checked={Boolean(checks[c.key])} onChange={(e) => setChecks((m) => ({ ...m, [c.key]: e.target.checked }))} />
          {c.label}
        </label>
      ))}
    </Modal>
  );
}

// 有未保存修改时，关闭前确认
export async function confirmDiscard(dirty, opts = {}) {
  if (!dirty) return true;
  return confirmDialog({
    title: '放弃未保存的修改？',
    message: '关闭后这次的修改不会保存。',
    okText: '放弃修改',
    cancelText: '继续编辑',
    danger: true,
    ...opts,
  });
}

// ---- 下拉菜单 ----
export function MenuButton({ button, tip, items, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false);
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  const trigger = cloneElement(button, { onClick: () => setOpen((o) => !o) });
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {tip && !open ? <Tip tip={tip}>{trigger}</Tip> : trigger}
      {open && (
        <div className="menu" style={{ [align]: 0, bottom: '100%', marginBottom: 6 }}>
          {items.filter(Boolean).map((it, i, list) =>
            // '-' 是分隔线（前后没有菜单项时不画）；{ label, group: true } 是分组小标题
            it === '-' ? (
              i > 0 && i < list.length - 1 && list[i - 1] !== '-' ? <div key={`sep${i}`} className="menu-sep" /> : null
            ) : it.group ? (
              <div key={`g${i}`} className="menu-label">
                {it.label}
              </div>
            ) : (
            <button
              key={it.label}
              className={it.danger ? 'danger' : ''}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.icon}
              {it.label}
            </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Switch({ on, onChange }) {
  return <button type="button" role="switch" aria-checked={on} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

export function Seg({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => {
        const btn = (
          <button key={o.value} type="button" className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
            {o.icon}
            {o.label}
          </button>
        );
        return o.tip ? (
          <Tip key={o.value} tip={o.tip}>
            {btn}
          </Tip>
        ) : (
          btn
        );
      })}
    </div>
  );
}

export const PALETTE = ['#1E65C0', '#FF7425', '#4A92E0', '#FFB060', '#A0C8F8'];

export function Loading({ text = '加载中' }) {
  return (
    <div className="loading-screen">
      <div>
        <div className="empty-art" style={{ justifyContent: 'center' }}>
          {PALETTE.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
        </div>
        <div style={{ textAlign: 'center' }}>{text}</div>
      </div>
    </div>
  );
}
