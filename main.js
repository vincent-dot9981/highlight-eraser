/* main.js — 網頁介面邏輯 */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const drop = $('drop'), fileInput = $('file'), chip = $('chip');
  const chipName = $('chipName'), chipSize = $('chipSize'), chipIcon = $('chipIcon');
  const clearBtn = $('clear'), goBtn = $('go'), progress = $('progress');
  const progressMsg = $('progressMsg'), result = $('result'), statsBox = $('stats');
  const beforeImg = $('before'), afterImg = $('after');
  const download = $('download'), again = $('again'), note = $('note'), toastEl = $('toast');
  const seg = $('seg'), sensHint = $('sensHint');

  const ACCEPT = ['pdf', 'heic', 'heif', 'jpg', 'jpeg', 'png', 'webp'];
  const SENS_HINT = {
    strict: '只認好鮮色、光線均勻嘅螢光筆；適合乾淨嘅數碼檔。',
    normal: '影相／掃描件建議先用「標準」。',
    loose: '淡色、陰影、舊掃描件用「寬鬆」；可能有少量誤中。',
  };

  let file = null;
  let sens = 'normal';
  let objectUrl = null;

  // ---------- 檔案 ----------
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function setFile(f) {
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!ACCEPT.includes(ext)) {
      toast('唔支援呢種格式，請揀 PDF、HEIC 或圖片。');
      return;
    }
    file = f;
    chipName.textContent = f.name;
    chipSize.textContent = fmtSize(f.size) + ' · ' + ext.toUpperCase();
    chipIcon.textContent = ext === 'pdf' ? '📄' : '🖼️';
    chip.classList.add('show');
    goBtn.disabled = false;
    hideResult();
  }

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    setFile(f);
  });

  clearBtn.addEventListener('click', () => reset());

  function reset() {
    file = null;
    fileInput.value = '';
    chip.classList.remove('show');
    goBtn.disabled = true;
    hideResult();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }

  // ---------- 靈敏度 ----------
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn) return;
    sens = btn.dataset.v;
    [...seg.children].forEach((x) => x.classList.toggle('on', x === btn));
    sensHint.textContent = SENS_HINT[sens];
  });

  // ---------- 處理 ----------
  goBtn.addEventListener('click', async () => {
    if (!file) return;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    setBusy(true);
    hideResult();
    try {
      let res;
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ext === 'pdf') {
        res = await processPdfFile(file, mode, sens, (pno, total) => {
          progressMsg.textContent = `處理第 ${pno} / ${total} 頁…（大檔案要少少時間）`;
        });
      } else {
        progressMsg.textContent = '解碼圖片同分析螢光筆…';
        res = await processImageFile(file, mode, sens);
      }
      showResult(res);
    } catch (err) {
      console.error(err);
      toast(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  });

  function setBusy(busy) {
    goBtn.disabled = busy || !file;
    goBtn.textContent = busy ? '處理中…' : '開始抹除';
    progress.classList.toggle('show', busy);
    if (busy) progressMsg.textContent = '分析螢光筆…';
  }

  function hideResult() {
    result.classList.remove('show');
    beforeImg.removeAttribute('src');
    afterImg.removeAttribute('src');
  }

  function showResult(res) {
    const s = res.stats;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(res.blob);

    statsBox.innerHTML = '';
    const kindTxt = s.kind === 'pdf' ? `PDF · ${s.pages} 頁` : `圖片 · ${s.width}×${s.height}`;
    const items = [
      [kindTxt, 'pill'],
      [`偵測到 ${s.bands} 處螢光筆`, s.bands > 0 ? 'pill' : 'pill warn'],
    ];
    if (s.kind === 'pdf' && s.pages_touched !== undefined) items.push([`已改動 ${s.pages_touched} 頁`, 'pill']);
    if (res.convertedFromHeic) items.push(['HEIC 已轉 JPEG', 'pill']);

    const seen = new Set();
    for (const [txt, cls] of items) {
      if (seen.has(txt)) continue;
      seen.add(txt);
      const el = document.createElement('span');
      el.className = cls;
      el.textContent = txt;
      statsBox.appendChild(el);
    }
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = `${s.elapsed.toFixed(2)} 秒`;
    statsBox.appendChild(t);

    beforeImg.src = res.beforeUrl;
    afterImg.src = res.afterUrl;

    const base = file.name.replace(/\.[^.]+$/, '');
    download.href = objectUrl;
    download.download = base + '_已抹除' + res.ext;
    download.textContent = '⬇️ 下載 ' + download.download;

    if (s.bands > 0) {
      let txt = s.mode === 'erase'
        ? '已把螢光筆（連顏色）換成頁面底色。'
        : '已抹走螢光筆下的文字，保留螢光底色。';
      if (s.rasterized > 0 && s.kind === 'pdf') {
        txt += ' PDF 以圖片方式重繪（外觀保留，文字唔再可選取）。';
      }
      note.textContent = txt;
    } else {
      note.textContent = '冇偵測到螢光筆顏色，結果同原檔一樣。可以試下將靈敏度調到「寬鬆」再嚟一次。';
    }
    result.classList.add('show');
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 4500);
  }

  again.addEventListener('click', () => {
    reset();
    drop.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
})();
