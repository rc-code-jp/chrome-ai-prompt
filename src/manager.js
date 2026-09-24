const STORAGE_KEY = 'prompts';
const $ = (id) => document.getElementById(id);

/** @type {{ id: string, title: string, body: string, createdAt: number, updatedAt: number }[]} */
let prompts = [];
let editingId = null;
let deleteTimer = 0;

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$('save-key').textContent = isMac ? '⌘↵' : 'Ctrl↵';

init();

async function init() {
  prompts = await load();
  renderList();

  $('add').addEventListener('click', () => openEditor(null));
  $('back').addEventListener('click', closeEditor);
  $('cancel').addEventListener('click', closeEditor);
  $('delete').addEventListener('click', onDelete);
  $('edit-view').addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });
  $('body').addEventListener('input', updateBodyCount);
  $('edit-view').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    prompts = changes[STORAGE_KEY].newValue ?? [];
    renderList();
  });
}

async function load() {
  const { [STORAGE_KEY]: stored } = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(stored) ? stored : [];
}

function persist() {
  return chrome.storage.local.set({ [STORAGE_KEY]: prompts });
}

function renderList() {
  const list = $('list');
  list.replaceChildren(...prompts.map((prompt, i) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'card';
    button.addEventListener('click', () => openEditor(prompt.id));

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);

    const meta = document.createElement('span');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = prompt.title || '無題のプロンプト';
    const snippet = document.createElement('span');
    snippet.className = 'snippet';
    snippet.textContent = prompt.body.replace(/\s+/g, ' ').trim() || '（本文なし）';
    meta.append(name, snippet);

    const chars = document.createElement('span');
    chars.className = 'chars';
    chars.textContent = `${[...prompt.body].length.toLocaleString()}字`;

    button.append(num, meta, chars);
    item.append(button);
    return item;
  }));
  $('count').textContent = prompts.length ? String(prompts.length) : '';
  $('empty').hidden = prompts.length > 0;
}

function openEditor(id) {
  editingId = id;
  const prompt = prompts.find((p) => p.id === id);
  $('title').value = prompt?.title ?? '';
  $('body').value = prompt?.body ?? '';
  $('edit-label').textContent = prompt ? 'EDIT PROMPT' : 'NEW PROMPT';
  $('delete').hidden = !prompt;
  disarmDelete();
  updateBodyCount();
  $('list-view').hidden = true;
  $('edit-view').hidden = false;
  (prompt ? $('body') : $('title')).focus();
}

function closeEditor() {
  editingId = null;
  $('edit-view').hidden = true;
  $('list-view').hidden = false;
}

function updateBodyCount() {
  const length = [...$('body').value].length;
  $('body-count').textContent = length ? `${length.toLocaleString()} 文字` : '';
}

async function save() {
  const body = $('body').value;
  if (!body.trim()) {
    const field = $('body');
    field.classList.remove('shake');
    void field.offsetWidth;
    field.classList.add('shake');
    field.focus();
    return;
  }
  const title = $('title').value.trim() || body.trim().split('\n')[0].slice(0, 24);
  const now = Date.now();
  const existing = prompts.find((p) => p.id === editingId);
  if (existing) {
    Object.assign(existing, { title, body, updatedAt: now });
  } else {
    prompts.unshift({ id: crypto.randomUUID(), title, body, createdAt: now, updatedAt: now });
  }
  await persist();
  closeEditor();
  renderList();
}

// 1 回目のクリックで確認状態にし、3 秒以内にもう一度押したら削除する
async function onDelete() {
  const button = $('delete');
  if (!button.classList.contains('armed')) {
    button.classList.add('armed');
    button.textContent = 'もう一度押して削除';
    deleteTimer = setTimeout(disarmDelete, 3000);
    return;
  }
  disarmDelete();
  prompts = prompts.filter((p) => p.id !== editingId);
  await persist();
  closeEditor();
  renderList();
}

function disarmDelete() {
  clearTimeout(deleteTimer);
  const button = $('delete');
  button.classList.remove('armed');
  button.textContent = '削除';
}
