// 初回インストール時にサンプルを入れておき、$$ を打てばすぐ動きを確認できるようにする。
const SAMPLE_PROMPTS = [
  {
    title: '要約して',
    body: '以下の内容を、重要なポイント 3〜5 個の箇条書きで簡潔に要約してください。\n\n',
  },
  {
    title: '丁寧なメールに整える',
    body: '以下の文章を、ビジネスメールとして自然で丁寧な日本語に書き直してください。要点は変えず、冗長な表現は削ってください。\n\n',
  },
  {
    title: 'コードレビュー',
    body: '以下のコードをレビューしてください。バグ・可読性・パフォーマンスの観点で、改善点を優先度の高い順に挙げてください。\n\n',
  },
];

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const { prompts } = await chrome.storage.local.get('prompts');
  if (prompts) return;
  const now = Date.now();
  await chrome.storage.local.set({
    prompts: SAMPLE_PROMPTS.map((p, i) => ({ id: crypto.randomUUID(), ...p, createdAt: now - i, updatedAt: now - i })),
  });
});

// content script からは openOptionsPage を呼べないので中継する
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'open-manager') chrome.runtime.openOptionsPage();
});
