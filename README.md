# 🖍️ 螢光筆抹除器（純前端版）

## 🌐 已經上線

**https://vincent-dot9981.github.io/highlight-eraser/**

任何人開呢條 link 就用得，唔需要登入、唔需要安裝；檔案完全留喺用家自己嘅瀏覽器。

上載 **PDF、掃描件、影相（支援 iPhone HEIC）**，自動找出實體螢光筆畫喺紙上嘅
highlight，再將被 highlight 嘅文字抹走。

**全部運算喺你嘅瀏覽器完成，檔案唔會上傳去任何伺服器**，所以可以直接放上
GitHub Pages／任何靜態主機，免費永久公開使用。

---

## 更新網站

呢個資料夾就係 GitHub repo（`vincent-dot9981/highlight-eraser`）嘅內容。
改完檔案之後：

```bash
git add -A && git commit -m "update" && git push
```

GitHub Pages 會自動重新部署（大約 1 分鐘）。

---

## 檔案結構

```
highlight-eraser-web/
├── index.html          # 介面
├── app.js              # 偵測／抹除引擎（白平衡、五色系、紙色場、PDF 註解 quad）
├── main.js             # 介面邏輯
├── vendor/
│   ├── pdf.min.js          # PDF 渲染（pdf.js）
│   ├── pdf.worker.min.js
│   ├── pdf-lib.min.js      # 砌返輸出 PDF
│   └── heic2any.min.js     # HEIC／HEIF 解碼（libheif WASM）
└── README.md
```

全部依賴都喺 `vendor/`，唔需要 CDN，載入一次之後就算離線都用得。

---

## 功能同限制

- 支援：PDF、HEIC／HEIF、JPG、PNG、WEBP
- 兩種模式：**連螢光筆一齊抹走**（預設）／**只抹字、保留螢光底色**
- 三種靈敏度：保守／標準／寬鬆
- PDF 輸出係「以圖片方式重繪」：外觀保留，但文字唔再可以選取
  （因為瀏覽器冇辦法喺 PDF 內真正刪字；如果用 Python 版就有真 redaction）
- 唔支援：TIFF、BMP、多頁 TIFF、加密 PDF
- 大相（例如 iPhone 12MP）分析時會自動縮到 1600px 做偵測，輸出保持原尺寸

---

## 私隱

- 檔案由頭到尾都留喺你部裝置；冇任何網絡請求（除咗第一次載入頁面本身）
- 冇 cookie、冇追蹤、冇後端
