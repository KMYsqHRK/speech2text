# 連続音声文字起こし

## 認識モード

| モード | 精度 | オフライン | 必要なもの |
|---|---|---|---|
| **Web Speech API** | 高（Google サーバー） | 不可 | Chrome + インターネット |
| **ローカル Whisper** | 中（tiny/base/small） | 可 | なし |

## 起動方法

```bash
# Python
python -m http.server 8080

# または Node.js
npx serve .
```

ブラウザで `http://localhost:8080` を開く。

> **注意**: `file://` から直接開いた場合、Web Speech API は動作しません。

## ファイル構成

```
index.html   # メインページ
style.css    # スタイル
app.js       # アプリケーションロジック
worker.js    # Whisper 推論 Worker（メインスレッドと分離）
```

## 技術スタック

- [Transformers.js](https://github.com/xenova/transformers.js) — ブラウザ上の Whisper 推論
- Web Speech API — Google サーバーサイド音声認識
- Web Audio API (ScriptProcessorNode) — gap ゼロの連続録音
- Web Worker — 推論をメインスレッドから分離し録音途切れを防止

## 現状と課題

- ブラウザ上のローカル Whisper は tiny/base では精度が限られる
- Web Speech API は `file://` / オフライン環境では動作しない
- 画面ロック時に録音が停止する（ブラウザの制約）→ネイティブアプリ化が必要
