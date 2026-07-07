# Taiwan Voice Recorder · SEL 情緒語音資料集錄音工具

用於快速錄製 SEL(社會情緒學習)情緒語音資料集的 Web 錄音小程式。
前端逐句顯示錄音腳本,錄完自動跳下一句;後端以 ffmpeg 標準化為訓練用 WAV 格式。

## 功能

- 逐句顯示錄音腳本(情緒標籤 + 句子 + 進度條)
- 一鍵錄音 / 停止 / 播放 / 重錄
- 錄音時即時 VU 音量表(dBFS 刻度,綠 / 黃 / 紅分區)
- 品質偵測:太小聲(< -35 dB)、太大聲(> -6 dB)、爆音(取樣削波)
- 錄製格式:WebM / Opus(關閉瀏覽器 AGC / 降噪 / 回音消除,保留原始聲音特徵)
- 後端 ffmpeg 轉檔:**WAV / PCM signed 16-bit / Mono / 24000 Hz**
- 上傳成功後自動跳至下一句
- 儲存結構:`data/original/`(原始 WebM)、`data/processed/`(轉檔 WAV)、`data/metadata.csv`

## 環境需求

- Node.js 18+
- ffmpeg(需在 PATH 中可執行)
  - macOS:`brew install ffmpeg`
  - Ubuntu:`sudo apt install ffmpeg`
  - Windows:https://ffmpeg.org/download.html

## 部署到 Railway(GitHub 連動,推薦)

### 1. 推上 GitHub

```bash
cd taiwan-voice-recorder
git init
git add .
git commit -m "Taiwan Voice Recorder"
git remote add origin https://github.com/<你的帳號>/taiwan-voice-recorder.git
git push -u origin main
```

### 2. Railway 建立服務

1. 到 https://railway.app → **New Project** → **Deploy from GitHub repo** → 選這個 repo
2. Railway 會自動偵測 `Dockerfile`(內含 ffmpeg)並開始建置

### 3. 掛載 Volume(必做,否則錄音資料會在重新部署時消失)

1. 服務卡片右鍵(或 Settings)→ **Attach Volume**
2. **Mount path 填 `/data`**
3. 到 **Variables** 新增:

| 變數 | 值 | 說明 |
|---|---|---|
| `DATA_DIR` | `/data` | 讓錄音資料寫進 Volume |
| `EXPORT_TOKEN` | 自訂一組密碼 | 保護資料集下載端點(建議必設,兒童語音屬敏感個資) |

### 4. 產生網址

**Settings → Networking → Generate Domain**,取得 `https://xxx.up.railway.app`。
自帶 HTTPS,平板 / 手機瀏覽器開啟即可直接使用麥克風。

### 5. 下載資料集(三種格式)

| 格式 | 網址 | 內容 |
|---|---|---|
| 全部 | `/api/export?token=密碼` | original(WebM)+ processed(WAV)+ metadata.csv |
| WAV | `/api/export?token=密碼&format=wav` | PCM16 Mono 24000Hz + metadata.csv |
| MP3 | `/api/export?token=密碼&format=mp3` | 128kbps 24kHz(即時轉檔)+ metadata.csv |
| WebM | `/api/export?token=密碼&format=webm` | 原始錄音 + metadata.csv |

> **個資提醒**:此網址等於公開的錄音入口,只分享給錄音工作人員;
> 資料收集告一段落後,建議下載資料集並暫停或移除服務。

## 本地安裝與啟動

```bash
npm install
node server.js
```

開啟瀏覽器 http://localhost:3000

> 麥克風權限:瀏覽器僅允許 `localhost` 或 HTTPS 使用 getUserMedia。
> 若要區網多人共用,請以 reverse proxy 加上 HTTPS,或用 Chrome flag
> `--unsafely-treat-insecure-origin-as-secure` 測試。

## 使用流程

1. 填寫錄音者代號(speaker)、年齡、備註 → 開始錄音工作
2. 依畫面情緒標籤唸出句子,觀察音量表保持在綠色區
3. 停止後系統顯示品質判定,可播放確認或重錄
4. 按「上傳並下一句」→ 自動儲存並跳到下一句腳本
5. 全部錄完後可換下一位錄音者

## metadata.csv 欄位

| 欄位 | 說明 |
|---|---|
| filename | 轉檔後的 WAV 檔名(與 processed/ 對應) |
| emotion | 情緒標籤(happy / sad / angry / fear / surprise / neutral) |
| text | 錄音腳本文字 |
| speaker | 錄音者代號 |
| age | 年齡 |
| source | 資料集來源代號(scripts.json 內設定) |
| createdAt | 上傳時間(ISO 8601) |
| notes | 備註 |

## 自訂錄音腳本

### 方式一:網頁上傳(推薦)

在開場設定頁的「自訂錄音腳本」區塊,直接上傳 **PDF / Word(.docx)/ TXT / JSON** 檔案。
檔案內每行一句,格式:

```
開心|哇,我們要去動物園玩了!
難過|我最喜歡的餅乾被吃完了。
angry|不可以隨便拿我的東西!
這是一句沒有標記的句子(自動視為中性 neutral)
```

- 情緒標籤支援中英文:開心/快樂/happy、難過/傷心/sad、生氣/憤怒/angry、害怕/緊張/fear、驚訝/surprise、中性/平靜/neutral
- 分隔符可用 `|`、`,`、`:` 或 Tab
- 若伺服器有設定 `EXPORT_TOKEN`,上傳時需填入管理 token
- 上傳的腳本存於 `DATA_DIR`(Railway Volume),重新部署不會遺失

### 方式二:編輯 scripts.json

編輯專案內建的 `scripts.json`(作為無上傳腳本時的預設):

```json
{
  "source": "VIA-SEL-v1",
  "scripts": [
    { "id": "S001", "emotion": "happy", "text": "你的句子" }
  ]
}
```

## 品質偵測參數

可在 `public/index.html` 調整:

| 常數 | 預設 | 說明 |
|---|---|---|
| `QUIET_DB` | -35 | 有效音框平均低於此值判定太小聲 |
| `LOUD_DB` | -6 | 高於此值判定太大聲 |
| `VOICE_DB` | -45 | 高於此值視為有語音的音框 |
| `CLIP_ABS` | 0.985 | 取樣絕對值門檻,超過計為削波(爆音) |
