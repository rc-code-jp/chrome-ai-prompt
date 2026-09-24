// Prompt Spark — content script
// 入力欄で $$（全角＄＄も可）と打つと確認モーダルを開き、選んだプロンプトで $$ を置き換える。
//
// UX 上の前提:
// - モーダル表示中もフォーカスは元の入力欄に残す。キー操作は window の capture で横取りし、
//   Enter で送信されてしまうサイト（Claude / Gemini など）にキーを渡さない。
// - 挿入・削除は execCommand で行い、エディタの undo 履歴に乗せる。
// - キャンセル時は $$ を削除する。
(() => {
  'use strict';

  const TRIGGER_CHAR = /[$＄]/;
  const TRIGGER_TAIL = /[$＄]{2}$/;
  const TRIGGER_EXACT = /^[$＄]{2}$/;
  const TRIGGER_LEN = 2;
  // selectionStart を持つ type のみ（email / number は selection API が使えない）
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel']);

  /**
   * @typedef {{ id: string, title: string, body: string }} Prompt
   * @typedef {{ kind: 'field', el: HTMLInputElement | HTMLTextAreaElement } | { kind: 'rich', el: HTMLElement }} Target
   * @typedef {{ target: Target, caret: number | Range, prompts: Prompt[], index: number, ui: ReturnType<typeof mountUI> | null }} Session
   */
  /** @type {Session | null} */
  let session = null;
  // 自分の execCommand が発火させる input で再トリガーしないためのフラグ（本文が $$ で終わる場合など）
  let replacing = false;

  // ---------------------------------------------------------------------------
  // トリガー検出
  // ---------------------------------------------------------------------------

  // isTrusted: ページのスクリプトが偽の $$ 入力や Enter を dispatch して、
  // プロンプトを自分の入力欄に挿入させて読み取る（抜き取る）のを防ぐ。
  addEventListener('input', (e) => {
    if (!e.isTrusted || session || replacing || e.isComposing || !e.data || !TRIGGER_CHAR.test(e.data)) return;
    if (e.inputType !== 'insertText' && e.inputType !== 'insertCompositionText') return;
    open(e.composedPath()[0]);
  }, true);

  // IME 確定（全角＄＄）は compositionend で判定する。エディタが DOM を確定させるのを 1 tick 待つ。
  addEventListener('compositionend', (e) => {
    if (!e.isTrusted || session || replacing || !e.data || !TRIGGER_CHAR.test(e.data)) return;
    const origin = e.composedPath()[0];
    setTimeout(() => {
      if (!session) open(origin);
    });
  }, true);

  function resolveTarget(node) {
    const el = node instanceof Element ? node : node?.parentElement;
    if (!el) return null;
    if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type))) {
      return el.readOnly || el.disabled ? null : { kind: 'field', el };
    }
    if (!el.isContentEditable) return null;
    let host = el;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    return { kind: 'rich', el: host };
  }

  function deepActiveElement() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function selectionFor(el) {
    const root = el.getRootNode();
    return (root instanceof ShadowRoot && root.getSelection?.()) || getSelection();
  }

  /** キャレット位置。field は offset、rich は Range（DOM 変更に追従する live range）。 */
  function readCaret({ kind, el }) {
    if (kind === 'field') {
      return el.selectionStart != null && el.selectionStart === el.selectionEnd ? el.selectionStart : null;
    }
    const sel = selectionFor(el);
    if (!sel?.rangeCount || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    return el.contains(range.startContainer) ? range.cloneRange() : null;
  }

  function textBefore({ kind, el }, caret) {
    if (kind === 'field') return el.value.slice(Math.max(0, caret - TRIGGER_LEN), caret);
    const { startContainer: node, startOffset: offset } = caret;
    if (node.nodeType === Node.TEXT_NODE && offset >= TRIGGER_LEN) {
      return node.data.slice(offset - TRIGGER_LEN, offset);
    }
    // キャレットが要素境界にある場合。$$ は同じ段落内にあるはずなので、
    // 文書全体ではなくキャレットを含むブロック要素の範囲だけを文字列化する。
    const range = document.createRange();
    range.selectNodeContents(closestBlock(node, el));
    range.setEnd(node, offset);
    return range.toString().slice(-TRIGGER_LEN);
  }

  function closestBlock(node, root) {
    const start = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const block = start?.closest('p, div, li, pre, blockquote, td, th, h1, h2, h3, h4, h5, h6');
    return block && root.contains(block) ? block : root;
  }

  async function open(origin) {
    const target = resolveTarget(origin);
    if (!target) return;
    const caret = readCaret(target);
    if (caret === null || !TRIGGER_TAIL.test(textBefore(target, caret))) return;
    if (!chrome.runtime?.id) return; // 拡張の再読み込み後に取り残されたスクリプト

    // session があるあいだはページへのキー入力を止めるので、どこで失敗しても必ず session を解除する
    const current = (session = { target, caret, prompts: [], index: 0, ui: null });
    try {
      const prompts = await loadPrompts();
      if (session !== current) return;
      if (!prompts) {
        session = null;
        return;
      }
      current.prompts = prompts;
      current.ui = mountUI(current);
    } catch (error) {
      if (session === current) session = null;
      console.warn('[Prompt Spark] モーダルを開けませんでした', error);
    }
  }

  const LOAD_TIMEOUT_MS = 1500;

  /** 読み込めなかったとき（拡張の再読み込み・タイムアウト）は null。壊れたデータは除外する。 */
  async function loadPrompts() {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, LOAD_TIMEOUT_MS, null);
    });
    try {
      const result = await Promise.race([chrome.storage.local.get('prompts'), timeout]);
      if (!result) return null;
      const { prompts } = result;
      if (!Array.isArray(prompts)) return [];
      return prompts
        .filter((p) => p && typeof p.body === 'string')
        .map((p) => ({ id: String(p.id), title: typeof p.title === 'string' ? p.title : '', body: p.body }));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // モーダル表示中のキー操作（ページ側には一切渡さない）
  // ---------------------------------------------------------------------------

  addEventListener('keydown', (e) => {
    if (!session || !e.isTrusted) return;
    e.stopImmediatePropagation();
    if (e.isComposing || e.keyCode === 229) return;
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        insertSelected();
        return;
      case 'Escape':
        e.preventDefault();
        dismiss();
        return;
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Tab': {
        e.preventDefault();
        const back = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey);
        move(back ? -1 : 1);
        return;
      }
    }
    // ⌘R などブラウザのショートカットは生かし、文字入力だけ止める
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
  }, true);

  for (const type of ['keypress', 'keyup']) {
    addEventListener(type, (e) => {
      if (session) e.stopImmediatePropagation();
    }, true);
  }

  addEventListener('beforeinput', (e) => {
    if (!session) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  function move(delta) {
    const s = session;
    if (!s?.ui || s.prompts.length < 2) return;
    s.index = (s.index + delta + s.prompts.length) % s.prompts.length;
    s.ui.render();
  }

  function select(index) {
    if (!session?.ui) return;
    session.index = index;
    session.ui.render();
  }

  function insertSelected() {
    const s = session;
    if (!s?.ui) return;
    const prompt = s.prompts[s.index];
    if (!prompt) {
      openManager();
      return;
    }
    close(s);
    replaceTrigger(s.target, s.caret, prompt.body);
  }

  function dismiss() {
    const s = session;
    if (!s) return;
    close(s);
    replaceTrigger(s.target, s.caret, '');
  }

  function openManager() {
    try {
      chrome.runtime.sendMessage({ type: 'open-manager' }).catch(() => {});
    } catch {
      // 拡張が再読み込みされて通信できない
    }
    dismiss();
  }

  function close(s) {
    session = null;
    s.ui?.unmount();
  }

  // ---------------------------------------------------------------------------
  // 置き換え
  // ---------------------------------------------------------------------------

  /** $$ を text に置き換える（text が空なら $$ を消すだけ）。 */
  function replaceTrigger(target, caret, text) {
    // モーダル表示中に React などが入力欄を作り直した場合は、いまフォーカスしている入力欄を使う
    const live = target.el.isConnected ? target : resolveTarget(deepActiveElement());
    if (!live) return;
    const { kind, el } = live;
    replacing = true;
    try {
      el.focus({ preventScroll: true });
      if (kind === 'field') replaceInField(el, caret, text);
      else replaceInRich(el, caret, text);
    } finally {
      replacing = false;
    }
  }

  function fieldHasTrigger(el, pos) {
    return pos != null && pos >= TRIGGER_LEN && TRIGGER_EXACT.test(el.value.slice(pos - TRIGGER_LEN, pos));
  }

  function replaceInField(el, caret, text) {
    const end = [caret, el.selectionStart].find((pos) => fieldHasTrigger(el, pos));
    if (end !== undefined) {
      editField(el, end - TRIGGER_LEN, end, text);
    } else if (text) {
      // $$ が見つからないときは選択範囲を上書きせず、選択の末尾に挿入する
      editField(el, el.selectionEnd, el.selectionEnd, text);
    }
  }

  function editField(el, start, end, text) {
    el.setSelectionRange(start, end);
    const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
    if (ok) return;
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: text ? 'insertText' : 'deleteContentBackward',
      data: text || null,
    }));
  }

  function replaceInRich(el, caret, text) {
    const sel = selectionFor(el);
    if (!sel) return;
    // 開いた時点のキャレットを優先し、エディタが DOM を描き直していたら現在のキャレットで探す
    const current = readCaret({ kind: 'rich', el });
    const found = [caret, current].some((range) => range && selectTrigger(sel, el, range));
    if (!found) {
      if (!text) return;
      // $$ が見つからないときは選択範囲を上書きせず、キャレット位置（なければ選択の末尾）に挿入する
      const fallback = [current, caret].find((range) => range && el.contains(range.startContainer));
      if (fallback) sel.collapse(fallback.startContainer, fallback.startOffset);
      else if (sel.rangeCount && el.contains(sel.focusNode)) sel.collapseToEnd();
      else return;
    }
    const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
    if (!ok && text) pasteText(el, text);
  }

  function selectTrigger(sel, el, caret) {
    if (!el.contains(caret.startContainer)) return false;
    sel.collapse(caret.startContainer, caret.startOffset);
    for (let i = 0; i < TRIGGER_LEN; i++) sel.modify('extend', 'backward', 'character');
    if (TRIGGER_EXACT.test(sel.toString())) return true;
    sel.collapse(caret.startContainer, caret.startOffset);
    return false;
  }

  function pasteText(el, text) {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
  }

  // ---------------------------------------------------------------------------
  // UI（Shadow DOM でページの CSS から隔離。Trusted Types 対策で innerHTML は使わない）
  // ---------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SPARKLE_PATH =
    'M10 3.5c.62 5.3 1.9 7.6 8 8.25v.5c-6.1.65-7.38 2.95-8 8.25h-.5c-.62-5.3-1.9-7.6-8-8.25v-.5c6.1-.65 7.38-2.95 8-8.25h.5Z' +
    'M18.6 1.5c.26 2.3.84 3.3 3.4 3.6v.4c-2.56.3-3.14 1.3-3.4 3.6h-.4c-.26-2.3-.84-3.3-3.4-3.6v-.4c2.56-.3 3.14-1.3 3.4-3.6h.4Z';

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value);
    }
    el.append(...children);
    return el;
  }

  function sparkle(className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', SPARKLE_PATH);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  }

  const kbd = (label) => h('kbd', {}, label);
  const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

  function adoptStyles(root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h('style', {}, STYLES));
    }
  }

  function mountUI(s) {
    const host = document.createElement('prompt-spark-root');
    // ページ側の !important（:not(:defined) { display: none !important } など）に負けないよう inline で固定する。
    // all は direction を含まないので、RTL のページでも反転しないよう別途指定する。
    host.style.cssText = [
      'all: initial',
      'display: block',
      'position: fixed',
      'inset: 0',
      'z-index: 2147483647',
      'direction: ltr',
    ].map((declaration) => `${declaration} !important;`).join(' ');
    const root = host.attachShadow({ mode: 'closed' });
    adoptStyles(root);

    const hasPrompts = s.prompts.length > 0;
    const items = s.prompts.map((prompt, i) =>
      h('div', { class: 'item', role: 'option', onclick: () => select(i), ondblclick: insertSelected },
        h('span', { class: 'num' }, String(i + 1)),
        h('span', { class: 'meta' },
          h('span', { class: 'name' }, prompt.title || '無題のプロンプト'),
          h('span', { class: 'snippet' }, oneLine(prompt.body)))));
    const list = h('div', { class: 'list', role: 'listbox', 'aria-label': '保存したプロンプト' }, ...items);
    const previewText = h('div', { class: 'preview-text' });
    const count = h('span', { class: 'count' });
    // フォーカスは入力欄に残るため、選択中のプロンプトはライブリージョンでスクリーンリーダーに伝える
    const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });

    const body = hasPrompts
      ? h('div', { class: 'body' },
          list,
          h('div', { class: 'preview' },
            h('div', { class: 'preview-head' },
              h('span', { class: 'label' }, sparkle(), 'PREVIEW'),
              count),
            previewText))
      : h('div', { class: 'body' },
          h('div', { class: 'empty' },
            h('div', { class: 'orb' }, sparkle()),
            h('div', { class: 'empty-title' }, 'まだプロンプトがありません'),
            h('div', { class: 'empty-text' }, 'ツールバーの Prompt Spark から登録すると、ここから呼び出せます。')));

    const wrap = h('div', { class: 'wrap' },
      h('div', { class: 'backdrop' }),
      h('section', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'プロンプトを挿入' },
        live,
        h('div', { class: 'ring' }),
        h('div', { class: 'surface' },
          h('header', { class: 'head' },
            h('div', { class: 'logo' }, sparkle()),
            h('div', { class: 'titles' },
              h('div', { class: 'title' }, 'プロンプトを挿入'),
              h('div', { class: 'subtitle' }, hasPrompts ? '$$ をこの内容に置き換えます' : '$$ で呼び出すプロンプトを登録しましょう')),
            h('span', { class: 'trigger' }, '$$')),
          body,
          h('footer', { class: 'foot' },
            h('div', { class: 'hints' },
              ...(hasPrompts ? [kbd('↑'), kbd('↓'), h('span', {}, '選択'), h('i')] : []),
              kbd('↵'), h('span', {}, hasPrompts ? '挿入' : '登録'), h('i'),
              kbd('esc'), h('span', {}, '閉じる')),
            h('div', { class: 'actions' },
              h('button', { class: 'btn ghost', type: 'button', onclick: dismiss }, 'キャンセル'),
              h('button', { class: 'btn primary', type: 'button', onclick: insertSelected },
                hasPrompts ? '挿入する' : 'プロンプトを登録',
                h('span', { class: 'enter' }, '↵')))))));

    // 外側クリックでキャンセル
    const modal = wrap.querySelector('.modal');
    wrap.addEventListener('click', (e) => {
      if (!modal.contains(e.target)) dismiss();
    });
    // フォーカスを入力欄に残したままにし、クリックをページ側に漏らさない
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'wheel']) {
      root.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'mousedown') e.preventDefault();
      });
    }

    function render() {
      items.forEach((item, i) => {
        const active = i === s.index;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
      });
      const prompt = s.prompts[s.index];
      if (!prompt) return;
      previewText.textContent = prompt.body;
      previewText.scrollTop = 0;
      previewText.classList.remove('reveal');
      void previewText.offsetWidth; // アニメーションを毎回やり直す
      previewText.classList.add('reveal');
      count.textContent = `${[...prompt.body].length.toLocaleString()} 文字`;
      keepVisible(list, items[s.index]);
      announce();
    }

    function announce() {
      const prompt = s.prompts[s.index];
      live.textContent = prompt
        ? `${prompt.title || '無題のプロンプト'}（${s.index + 1} / ${s.prompts.length}）。Enter で挿入、Esc で閉じる`
        : 'まだプロンプトがありません。Enter で登録画面を開く、Esc で閉じる';
    }

    function unmount() {
      wrap.classList.add('closing');
      setTimeout(() => host.remove(), 160);
    }

    root.append(wrap);
    document.documentElement.append(host);
    try {
      render();
    } catch (error) {
      host.remove();
      throw error;
    }
    setTimeout(announce, 100); // 挿入直後の変更は読み上げられないことがあるので、表示後にもう一度
    return { render, unmount };
  }

  function keepVisible(container, item) {
    if (!item) return;
    const top = item.offsetTop - container.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < container.scrollTop) container.scrollTop = top - 4;
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight + 4;
  }

  const STYLES = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.wrap {
  --text: #eceefe;
  --muted: #979dc4;
  --faint: #7f87b0;
  --line: rgba(196, 200, 255, 0.09);
  --violet: #8b5cf6;
  --indigo: #6366f1;
  --cyan: #22d3ee;
  --pink: #e879f9;
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  color: var(--text);
  color-scheme: dark;
  font: 13px/1.5 "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  text-align: left;
  direction: ltr;
  unicode-bidi: isolate;
  user-select: none;
}

.backdrop {
  position: fixed;
  inset: 0;
  background:
    radial-gradient(900px 520px at 50% 45%, rgba(99, 102, 241, 0.20), transparent 65%),
    rgba(5, 6, 16, 0.55);
  backdrop-filter: blur(6px) saturate(125%);
  animation: fade-in 0.2s ease both;
}

.modal {
  position: relative;
  display: flex;
  width: min(560px, 100%);
  max-height: min(620px, calc(100vh - 32px));
  padding: 1px;
  border-radius: 20px;
  overflow: hidden;
  isolation: isolate;
  background: rgba(196, 200, 255, 0.12);
  box-shadow:
    0 30px 80px -24px rgba(0, 0, 0, 0.75),
    0 0 70px -14px rgba(139, 92, 246, 0.5),
    0 0 140px -40px rgba(34, 211, 238, 0.45);
  animation: modal-in 0.32s cubic-bezier(0.2, 0.9, 0.25, 1.12) both;
}
/* JS の requestAnimationFrame に頼らず CSS だけで表示する（描画が止まっているフレームでも透明のまま残らない） */
.closing .backdrop { animation: fade-out 0.14s ease both; }
.closing .modal { animation: modal-out 0.14s ease both; }
@keyframes fade-in { from { opacity: 0; } }
@keyframes fade-out { to { opacity: 0; } }
@keyframes modal-in { from { opacity: 0; transform: translateY(12px) scale(0.97); } }
@keyframes modal-out { to { opacity: 0; transform: translateY(6px) scale(0.985); } }

/* 回転するグラデーションの縁取り */
.ring {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 300%;
  aspect-ratio: 1;
  translate: -50% -50%;
  z-index: -1;
  background: conic-gradient(
    transparent 0deg, var(--violet) 50deg, var(--cyan) 105deg, transparent 150deg,
    transparent 190deg, var(--pink) 245deg, var(--indigo) 300deg, transparent 350deg);
  animation: spin 6s linear infinite;
}
@keyframes spin { to { rotate: 360deg; } }

.surface {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  border-radius: 19px;
  overflow: hidden;
  background:
    radial-gradient(440px 240px at 0% 0%, rgba(139, 92, 246, 0.22), transparent 70%),
    radial-gradient(420px 260px at 100% 100%, rgba(34, 211, 238, 0.13), transparent 70%),
    linear-gradient(180deg, #14152a, #0c0d1b);
}
.surface::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(rgba(210, 214, 255, 0.08) 1px, transparent 1px);
  background-size: 16px 16px;
  -webkit-mask-image: linear-gradient(180deg, #000, transparent 38%);
  mask-image: linear-gradient(180deg, #000, transparent 38%);
}

.head {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px 14px;
}
.logo {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  color: #fff;
  background: linear-gradient(135deg, var(--violet), var(--indigo) 50%, var(--cyan));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2), 0 8px 22px -6px rgba(139, 92, 246, 0.85);
}
.logo svg { width: 20px; height: 20px; animation: twinkle 2.6s ease-in-out infinite; }
@keyframes twinkle { 50% { transform: scale(0.84) rotate(14deg); opacity: 0.82; } }
.titles { flex: 1; min-width: 0; }
.title {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0.01em;
  background: linear-gradient(90deg, #ffffff, #cdc6ff 55%, #9ee9f7);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.subtitle { margin-top: 1px; font-size: 12px; color: var(--muted); }
.trigger {
  flex: none;
  padding: 4px 10px;
  border-radius: 999px;
  font: 600 12px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: #dcd2ff;
  background: rgba(139, 92, 246, 0.16);
  box-shadow: inset 0 0 0 1px rgba(167, 139, 250, 0.4), 0 0 18px -4px rgba(139, 92, 246, 0.6);
}

.body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 0 20px 16px;
  overflow: auto;
  overscroll-behavior: contain;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 190px;
  margin: -2px;
  padding: 2px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.item:hover { background: rgba(196, 200, 255, 0.05); }
.item.active {
  background: linear-gradient(90deg, rgba(139, 92, 246, 0.24), rgba(99, 102, 241, 0.10) 60%, rgba(34, 211, 238, 0.06));
  box-shadow: inset 0 0 0 1px rgba(167, 139, 250, 0.4);
}
.num {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  font: 600 11px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: var(--muted);
  background: rgba(196, 200, 255, 0.06);
  box-shadow: inset 0 0 0 1px var(--line);
}
.item.active .num {
  color: #fff;
  background: linear-gradient(135deg, var(--violet), var(--indigo));
  box-shadow: 0 0 14px -2px rgba(139, 92, 246, 0.8);
}
.meta { display: flex; flex-direction: column; min-width: 0; }
.name, .snippet { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.name { font-weight: 600; }
.snippet { font-size: 12px; color: var(--faint); }
.item.active .snippet { color: var(--muted); }

.preview {
  position: relative;
  flex: none;
  border-radius: 14px;
  background: rgba(4, 5, 14, 0.55);
  box-shadow: inset 0 0 0 1px var(--line);
  overflow: hidden;
}
.preview::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(139, 92, 246, 0.9), rgba(34, 211, 238, 0.9), transparent);
}
.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 0;
}
.label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: #b8a6ff;
}
.label svg { width: 12px; height: 12px; color: var(--cyan); }
.count { font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
.preview-text {
  max-height: 220px;
  padding: 8px 14px 14px;
  overflow: auto;
  overscroll-behavior: contain;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
  color: #d7daf4;
  scrollbar-width: thin;
}
.preview-text.reveal { animation: materialize 0.32s ease-out; }
@keyframes materialize {
  from { opacity: 0; filter: blur(5px); transform: translateY(3px); }
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 12px 8px;
  text-align: center;
}
.orb {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin-bottom: 8px;
  border-radius: 50%;
  color: #fff;
  background:
    radial-gradient(circle at 30% 28%, rgba(255, 255, 255, 0.4), transparent 42%),
    linear-gradient(135deg, var(--violet), var(--indigo) 50%, var(--cyan));
  box-shadow: 0 0 44px -6px rgba(139, 92, 246, 0.9);
  animation: float 3.2s ease-in-out infinite;
}
.orb svg { width: 26px; height: 26px; }
@keyframes float { 50% { transform: translateY(-4px); } }
.empty-title { font-size: 14px; font-weight: 650; }
.empty-text { max-width: 300px; font-size: 12.5px; color: var(--muted); }

.foot {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--line);
  background: rgba(196, 200, 255, 0.015);
}
.hints {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--faint);
  white-space: nowrap;
}
.hints i { width: 6px; }
kbd {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 6px;
  font: 500 11px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: var(--muted);
  background: rgba(196, 200, 255, 0.07);
  box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.45), inset 0 0 0 1px var(--line);
}
.actions { display: flex; gap: 8px; margin-left: auto; }
.btn {
  all: unset;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 14px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  overflow: hidden;
  transition: background 0.15s ease, color 0.15s ease, filter 0.15s ease, transform 0.15s ease;
}
.btn:active { transform: translateY(1px); }
.ghost { color: var(--muted); box-shadow: inset 0 0 0 1px var(--line); }
.ghost:hover { color: var(--text); background: rgba(196, 200, 255, 0.06); }
.primary {
  color: #fff;
  background: linear-gradient(135deg, var(--violet), var(--indigo) 55%, #0ea5e9);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16), 0 8px 24px -8px rgba(124, 92, 246, 0.95);
}
.primary:hover { filter: brightness(1.12) saturate(1.1); }
.primary::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 30%, rgba(255, 255, 255, 0.32) 50%, transparent 70%);
  transform: translateX(-120%);
  animation: shimmer 3.2s ease-in-out 0.5s infinite;
}
@keyframes shimmer { 55%, 100% { transform: translateX(120%); } }
.enter {
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.18);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 460px) {
  .head { padding: 16px 16px 12px; }
  .body { padding: 0 16px 14px; }
  .foot { padding: 12px 16px 14px; }
  .hints { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ring, .logo svg, .orb, .primary::after, .preview-text.reveal { animation: none; }
  .modal, .backdrop { animation-duration: 0.01s !important; }
}
`;
})();
