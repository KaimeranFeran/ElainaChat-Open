/* ElainaChat · 表情识别（桌宠与 Galgame 共用，避免词表分叉 —— OCR M3） */
(function () {
  'use strict';
  const KEY = [
    ['happy', /微笑|开心|高兴|嘿嘿|哈哈|愉快|喜悦|太好了|棒/],
    ['angry', /生气|气死|哼|愤怒|恼火|讨厌/],
    ['confused', /疑惑|奇怪|嗯？|不懂|迷茫|\?\s*$/],
    ['shy', /害羞|脸红|唔|呜|别、?别/],
    ['surprised', /惊讶|吃惊|诶|哎|居然|竟然|！/],
    ['resigned', /无奈|叹气|唉|算了/],
    ['speechless', /无语|真是的|服了|…{2,}/],
    ['smirk', /坏笑|狡黠|得意|偷笑/]
  ];
  window.ElainaEmotion = {
    from(text) {
      const t = String(text || '');
      for (const [k, re] of KEY) { if (re.test(t)) return k; }
      return null;
    },
    list() { return KEY.map(k => k[0]); },
    labels() {
      return { smirk: '坏笑', shy: '害羞', calm: '平静', surprised: '惊讶', resigned: '无奈',
               speechless: '无语', angry: '生气', confused: '疑惑', happy: '高兴' };
    }
  };
})();
