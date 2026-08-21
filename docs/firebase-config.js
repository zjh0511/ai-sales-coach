// Firebase 設定。
//
// 這幾個值是「公開資訊」，會出現在網頁原始碼裡，不是機密——任何人打開開發者
// 工具都看得到，Google 的文件也是這樣寫的。真正的保護來自 Realtime Database
// 的安全規則：只有登入者本人讀寫得到自己那一份資料。
//
// 還沒填的時候，整個帳號功能會自動關閉，App 的行為與加入帳號功能之前完全相同。
// 設定步驟見 account-setup.html。
export const FB = {
  apiKey: '',          // Firebase 專案設定 → 網頁應用程式 → apiKey
  dbUrl: '',           // Realtime Database 的網址，例：https://xxx-default-rtdb.asia-southeast1.firebasedatabase.app
  googleClientId: '',  // Google Cloud → 憑證 → OAuth 2.0 用戶端 ID（網頁應用程式），例：123-abc.apps.googleusercontent.com

  // 以下兩項只有要開 Apple 登入才需要。
  // Apple 登入需要「付費的 Apple Developer 帳號」（約 NT$3,300／年）才能申請憑證，
  // 這是 Apple 的規定，不是這支程式的限制。
  appleClientId: '',   // Apple Developer → Services ID，例：com.example.aicoach.web
  apple: false,        // 憑證都設好、Firebase 後台也啟用 Apple 之後改成 true
};
