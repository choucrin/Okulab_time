// E2E 専用の匿名認証スタブ(本番 Firebase には接続しない)。ページごとに別の uid を返す。
const uid = "e2e-" + Math.random().toString(36).slice(2, 10);
export function getAuth() { return { type: "auth" }; }
export async function signInAnonymously() { return { user: { uid } }; }
