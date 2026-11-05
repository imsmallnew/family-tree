# 家族族譜系統 (Family Tree Web App)

這是一個基於 **React + TypeScript + Vite + Firebase** 架構設計的家族族譜管理與查詢系統，專為家族成員與長輩閱讀體驗最佳化。

## 核心功能與特色
1. **長輩友善大字體設計**：預設採用放大字級與高對比配色，並提供頂部「🔍 字體：標準 / 大字 / 特大(長輩)」一鍵切換按鈕。
2. **左上角族譜標題維護**：管理員與編輯者可直接點擊左上角「✏️ 修改標題」，自訂代表字、家族主標題與副標題，並自動同步至雲端。
3. **族譜樹狀圖 & 動態稱謂計算機**：選擇任一成員作為「出發點（視角）」，自動推算出該成員對其他所有親戚的台灣/中文稱謂。
4. **成員個人檔案與照片上傳**：支援大頭照上傳（Firebase Storage / 自動縮圖備援）、國曆与農曆生日、FB / LINE 連結維護。
5. **Firebase 雲端即時連動**：
   - 支援透過介面點擊「☁️ 設定 Firebase 連動」直接貼上 `firebaseConfig` 綁定，或透過 `.env.local` 設定。
   - 自動同步 `settings/familyInfo`（標題設定）、`members`（成員資料）與 `relationships`（關係圖譜）。
   - 預設隱藏技術性的「Firestore 資料表預覽 (JSON)」頁籤，保持長輩瀏覽介面清爽。

## 啟動本地開發伺服器 (Localhost)

```bash
npm install
npm run dev
```

啟動後請在瀏覽器開啟：`http://localhost:5173`
