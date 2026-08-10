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
  apiKey: "AIzaSyDAJfY38qAan4HK6mgs3kOy6bo0BXUOXUY",
  authDomain: "okulab-time.firebaseapp.com",
  projectId: "okulab-time",
  storageBucket: "okulab-time.firebasestorage.app",
  messagingSenderId: "503694436384",
  appId: "1:503694436384:web:3ea36039d0379acb117445",
};
