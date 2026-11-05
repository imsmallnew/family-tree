# 家族族譜系統 (Family Tree Web App)

這是一個基於 **React + TypeScript + Firebase** 架構設計的家族族譜管理與查詢系統。

## 核心功能
1. **族譜樹狀圖**：視覺化呈現跨世代親屬關係（支援外公外婆 → 爸媽 → 我/哥哥/大嫂 → 姪女 A/B）。
2. **動態稱謂計算機**：選擇任一成員作為「出發點（視角）」，自動透過圖論（BFS 最短路徑關係鏈）計算出該成員對其他所有親戚的正確台灣/中文稱謂。
3. **成員個人檔案與照片上傳**：支援大頭照上傳（Firebase Storage）、生日（西曆/農曆）、FB / LINE 連結維護。
4. **權限與邀請制安全控管**：結合 Firebase Authentication 與 Firestore Security Rules，區分管理員（Admin）、編輯者（Editor）與唯讀成員（Viewer）。

## 資料結構概念 (Graph Data Model)
不將樹狀結構寫死，而是拆分為兩個核心 Collection：
- `members`：紀錄每個人的獨立屬性（姓名、性別、生日、照片 URL、FB/LINE、輩分等）。
- `relationships`：以 `{ fromId, toId, type: 'parent' | 'spouse' }` 記錄關係，方便未來無限擴充家族成員與旁系血親。

