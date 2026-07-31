// ─────────────────────────────────────────────────────────────
//  Firebase の設定値
//
//  Firebase コンソール →(歯車)プロジェクトの設定 → マイアプリ → ウェブアプリ
//  に表示される firebaseConfig の中身を、そのまま下に貼り替えてください。
//
//  ここに書く apiKey は「公開されて構わない識別子」です(秘密鍵ではありません)。
//  実際のアクセス制御は Firestore セキュリティルール(firestore.rules)で行います。
// ─────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};
