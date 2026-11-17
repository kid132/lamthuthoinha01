/**
 * ==============================================================================
 * Shopee Live Pro Suite - Standalone All-in-One Multi-Room Lucky Draw & Live Tools
 * (Bản v2.4 - SĂN XU TỐC ĐỘ CAO 100ms - Tự động quay chuẩn từng mili-giây, Tự ngừng khi đạt tối đa giải)
 * 
 * Tính năng nổi bật v2.3:
 * 1. 🛑 Tự động phát hiện khi đạt tối đa lượt trúng giải trong ngày (mã lỗi Shopee hoặc đạt mốc cài đặt)
 * 2. 🛑 Tự động DỪNG QUAY NGAY LẬP TỨC để bảo vệ tài khoản, tránh spam tốn tài nguyên
 * 3. 📊 Hiển thị bộ đếm số lượt trúng thưởng trực tiếp trên thanh trạng thái (VD: Đã trúng: 2/10 giải)
 * 4. ⚙️ Tùy chỉnh số giải tối đa trong ngày (mặc định 10 lượt) trong phần Cài đặt
 * 5. ✈️ Báo Telegram và phát chuông thông báo ngay khi chạm giới hạn
 * ==============================================================================
 */

(function () {
  'use strict';

  // Dọn dẹp phiên bản cũ nếu đang chạy để nạp mới hoàn toàn
  const existingShell = document.getElementById('shopee-live-tools-shell');
  if (existingShell) {
    existingShell.remove();
  }
  if (window._slpLuckyTimer) { clearInterval(window._slpLuckyTimer); window._slpLuckyTimer = null; }
  if (window._slpScanTimer) { clearInterval(window._slpScanTimer); window._slpScanTimer = null; }

  // ==========================================
  // 1. CẤU HÌNH & TRẠNG THÁI (STATE & SETTINGS)
  // ==========================================
  const STORAGE_KEY = 'SHOPEE_LIVE_PRO_SETTINGS';
  const defaultSettings = {
    telegramEnabled: false,
    telegramToken: '',
    telegramChatId: '',
    browserNotify: false,
    soundEnabled: true,
    requestDelay: 3,
    cartRefreshInterval: 7,
    autoSpin: true,
    autoClaimVoucher: true,
    spinInterval: 1000,
    maxDailyWins: 10 // Giới hạn tối đa số giải trúng mỗi ngày
  };

  let settings = Object.assign({}, defaultSettings);
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) settings = Object.assign(settings, JSON.parse(saved));
  } catch (e) {
    console.warn('[ShopeeLivePro] Lỗi đọc settings:', e);
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('[ShopeeLivePro] Lỗi lưu settings:', e);
    }
  }

  // Quản lý số lần trúng thưởng hôm nay theo ngày (UTC+7)
  function getTodayKey() {
    const d = new Date(Date.now() + 7 * 3600 * 1000);
    return `SLP_DAILY_WINS_${d.toISOString().slice(0, 10)}`;
  }

  function getDailyWinsCount() {
    try {
      return Number(localStorage.getItem(getTodayKey())) || 0;
    } catch (e) {
      return 0;
    }
  }

  function incrementDailyWins() {
    const current = getDailyWinsCount() + 1;
    try {
      localStorage.setItem(getTodayKey(), String(current));
    } catch (e) {}
    updateStatusDisplay();
    return current;
  }

  // ==========================================
  // 2. TIMESYNC ENGINE (ĐỒNG BỘ THỜI GIAN CHUẨN)
  // ==========================================
  const Clock = {
    offsetMs: 0,
    synced: false,
    async sync() {
      try {
        const t0 = performance.now();
        const resp = await fetch('https://live.shopee.vn/api/v1/session/1', { method: 'HEAD', cache: 'no-cache' });
        const dateStr = resp.headers.get('date');
        const t1 = performance.now();
        if (dateStr) {
          const serverEpoch = new Date(dateStr).getTime();
          const rtt = t1 - t0;
          this.offsetMs = (serverEpoch + rtt / 2) - Date.now();
          this.synced = true;
          Logger.info(`[TimeSync] Đã đồng bộ với máy chủ Shopee (Offset: ${Math.round(this.offsetMs)}ms)`);
          return;
        }
      } catch (e) {}

      try {
        const t0 = performance.now();
        const resp = await fetch('https://timeapi.io/api/time/current/zone?timeZone=UTC', { cache: 'no-cache' });
        const data = await resp.json();
        const t1 = performance.now();
        const serverEpoch = new Date(data.dateTime + 'Z').getTime();
        const rtt = t1 - t0;
        this.offsetMs = (serverEpoch + rtt / 2) - Date.now();
        this.synced = true;
        Logger.info(`[TimeSync] Đã đồng bộ chuẩn UTC (Offset: ${Math.round(this.offsetMs)}ms)`);
      } catch (err) {
        Logger.warn('[TimeSync] Dùng giờ hệ thống máy tính.');
      }
    },
    now() {
      return Date.now() + this.offsetMs;
    },
    nowSec() {
      return Math.floor(this.now() / 1000);
    },
    formatTime(epochMs) {
      const d = new Date(epochMs || this.now());
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const ms = String(Math.floor(d.getMilliseconds() / 100));
      return `${hh}:${mm}:${ss}.${ms}`;
    },
    formatHHMMSS(epochSec) {
      const d = new Date(epochSec * 1000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    }
  };

  // ==========================================
  // 3. LOGGER & THÔNG BÁO (LOGGER & NOTIFY)
  // ==========================================
  const Logger = {
    containers: [],
    register(el) {
      if (el && !this.containers.includes(el)) this.containers.push(el);
    },
    log(text, type = 'info') {
      const timeStr = Clock.formatTime();
      const entry = `[${timeStr}] ${text}`;
      console.log(`[ShopeeLivePro][${type.toUpperCase()}] ${entry}`);

      this.containers.forEach(c => {
        if (!c) return;
        const div = document.createElement('div');
        div.className = `log-entry log-${type}`;
        div.textContent = entry;
        c.appendChild(div);
        c.scrollTop = c.scrollHeight;
      });

      PiPManager.addLog(entry, type);
    },
    info(text) { this.log(text, 'info'); },
    success(text) {
      this.log(text, 'success');
      notifyExternal(text);
      if (settings.soundEnabled) playAlertSound();
    },
    warn(text) { this.log(text, 'warning'); },
    error(text) { this.log(text, 'error'); },
    clear() {
      this.containers.forEach(c => { if (c) c.innerHTML = ''; });
    }
  };

  function playAlertSound(freq = 880) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (e) {}
  }

  async function notifyExternal(message) {
    if (settings.browserNotify && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('Shopee Live Pro', { body: message, icon: 'https://shopee.vn/favicon.ico' });
      } catch (e) {}
    }

    if (settings.telegramEnabled && settings.telegramToken && settings.telegramChatId) {
      try {
        const url = `https://api.telegram.org/bot${settings.telegramToken}/sendMessage`;
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: settings.telegramChatId,
            text: `🎯 [Shopee Live Pro]\n${message}\n⏰ ${new Date().toLocaleTimeString('vi-VN')}`
          })
        });
      } catch (err) {
        console.warn('[ShopeeLivePro] Lỗi gửi Telegram:', err);
      }
    }
  }

  // ==========================================
  // 4. SHOPEE LIVE CORE API
  // ==========================================
  const ShopeeAPI = {
    getCurrentSessionId() {
      const url = new URL(window.location.href);
      let s = url.searchParams.get('session');
      if (s) return s;
      const match = window.location.pathname.match(/\/(\d{5,})/);
      if (match) return match[1];
      try {
        if (window.__INITIAL_STATE__?.live?.sessionId) {
          return String(window.__INITIAL_STATE__.live.sessionId);
        }
      } catch (e) {}
      return null;
    },

    async getMultiRoomLuckyDraws(mode = 'MIN', budget = 5700) {
      try {
        const payload = { type: 'get_luckydraw' };
        if (mode === 'MIN') {
          payload.min_budget = Number(budget) || 5700;
        } else {
          payload.max_budget = Number(budget) || 5700;
        }

        const resp = await fetch('https://4anm.top/api/shopee', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const json = await resp.json();
        if (json && json.success && Array.isArray(json.data)) {
          return json.data;
        }
      } catch (e) {
        Logger.error(`Lỗi tải danh sách vòng quay: ${e.message}`);
      }
      return [];
    },

    async followShop(sessionId, shopId) {
      try {
        const resp = await fetch(`https://live.shopee.vn/api/v1/session/${sessionId}/follow/${shopId}`, {
          method: 'POST',
          credentials: 'include'
        });
        return await resp.json();
      } catch (e) {
        return null;
      }
    },

    async playLuckyDraw(sessionId, drawId) {
      try {
        const resp = await fetch(`https://live.shopee.vn/api/v1/draw/session/${sessionId}/play`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draw_id: Number(drawId) })
        });
        return await resp.json();
      } catch (e) {
        return { error: e.message };
      }
    },

    async claimLuckyDraw(sessionId, drawId) {
      try {
        const resp = await fetch(`https://live.shopee.vn/api/v1/draw/session/${sessionId}/claim`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draw_id: Number(drawId) })
        });
        return await resp.json();
      } catch (e) {
        return { error: e.message };
      }
    },

    async getSessionVouchers(sessionId) {
      try {
        const resp = await fetch(`https://live.shopee.vn/api/v1/session/${sessionId}/voucher_list`, {
          credentials: 'include'
        });
        const data = await resp.json();
        return data?.data?.vouchers || data?.data || [];
      } catch (e) {
        return [];
      }
    },

    async claimVoucher(voucherCode, promotionId = null, signature = '') {
      try {
        const resp = await fetch('https://shopee.vn/api/v2/voucher_wallet/save_voucher', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            voucher_code: voucherCode,
            voucher_promotionid: promotionId,
            signature: signature
          })
        });
        return await resp.json();
      } catch (e) {
        try {
          const resp2 = await fetch('https://live.shopee.vn/api/v1/voucher/claim', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voucher_code: voucherCode })
          });
          return await resp2.json();
        } catch (e2) {
          return { error: e2.message };
        }
      }
    },

    async getLiveCartItems(sessionId, offset = 0, limit = 100) {
      try {
        const resp = await fetch(`https://live.shopee.vn/api/v1/session/${sessionId}/item_list?offset=${offset}&limit=${limit}`, {
          credentials: 'include'
        });
        const data = await resp.json();
        return data?.data?.items || [];
      } catch (e) {
        return [];
      }
    }
  };

  // ==========================================
  // 5. LUCKY DRAW ENGINE (QUÉT & SĂN ĐA PHÒNG)
  // ==========================================
  let luckyRooms = [];
  let roomStatusMap = new Map();
  let blockedRooms = new Set();
  let isLuckyRunning = true; // Mặc định tự chạy khi mở
  let isMaxLimitReached = false; // Đã đạt tối đa lượt trúng hôm nay
  let luckyScanInterval = null;
  let luckyCountdownTimer = null;
  let luckyMode = 'MIN';
  let luckyTargetBudget = 5700;
  let luckyPreStartTime = 3;

  function updateStatusDisplay() {
    const stText = document.getElementById('lucky-status-text');
    if (!stText) return;

    const wins = getDailyWinsCount();
    const maxWins = Number(settings.maxDailyWins) || 10;

    if (isMaxLimitReached || wins >= maxWins) {
      stText.innerHTML = `Trạng thái: <span style="color:#dc2626;font-weight:bold;">🛑 ĐÃ ĐẠT GIỚI HẠN GIẢI HÔM NAY (${wins}/${maxWins}) - ĐÃ NGỪNG QUAY</span>`;
    } else if (isLuckyRunning) {
      stText.innerHTML = `Trạng thái: <span style="color:#16a34a;font-weight:bold;">🟢 Đang tự động săn xu</span> <span style="color:#64748b;font-size:12px;">(Đã trúng: ${wins}/${maxWins} giải hôm nay)</span>`;
    } else {
      stText.innerHTML = `Trạng thái: <span style="color:#ef4444;font-weight:bold;">🔴 Đã dừng</span> <span style="color:#64748b;font-size:12px;">(Đã trúng: ${wins}/${maxWins} giải hôm nay)</span>`;
    }
  }

  // 🛑 DỪNG QUAY TOÀN BỘ KHI ĐẠT GIỚI HẠN
  function stopDueToMaxLimit(reason = 'Đạt giới hạn lượt trúng tối đa hôm nay') {
    isMaxLimitReached = true;
    isLuckyRunning = false;

    const btn = document.getElementById('btnToggleRun');
    if (btn) {
      btn.innerHTML = '🚀 Bắt đầu';
      btn.className = 'btn primary';
    }

    if (luckyScanInterval) clearInterval(luckyScanInterval);
    updateStatusDisplay();

    Logger.warn(`🛑 [VÒNG QUAY ĐÃ DỪNG] ${reason}! Hệ thống tự động ngừng quay các phòng tiếp theo để bảo vệ tài khoản.`);
    notifyExternal(`🛑 Shopee Live Pro: ${reason}. Hệ thống đã tự động dừng săn xu hôm nay!`);
    if (settings.soundEnabled) playAlertSound(440);

    renderLuckyTable();
  }

  async function fetchAndRenderLuckyRooms() {
    if (isMaxLimitReached) return;

    const rawData = await ShopeeAPI.getMultiRoomLuckyDraws(luckyMode, luckyTargetBudget);
    const nowSec = Clock.nowSec();

    const validRooms = (rawData || []).filter(room => {
      const remainingSec = (room.start_time || 0) - nowSec;
      const cached = roomStatusMap.get(String(room.draw_id));
      return remainingSec >= -1 || (cached && cached.played);
    });

    validRooms.sort((a, b) => (a.start_time || 0) - (b.start_time || 0));

    validRooms.forEach(room => {
      const cached = roomStatusMap.get(String(room.draw_id));
      if (cached) {
        room._result = cached.result;
        room._playing = cached.playing;
        room._played = cached.played;
      }
    });

    luckyRooms = validRooms;
    renderLuckyTable();
  }

  function renderLuckyTable() {
    const tbody = document.getElementById('lucky-table-body');
    if (!tbody) return;

    const nowSec = Clock.nowSec();
    const displayRooms = luckyRooms.filter(r => {
      const remainingSec = (r.start_time || 0) - nowSec;
      return remainingSec >= -45 || r._result;
    });

    if (displayRooms.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:30px;color:#64748b;">Đang tìm kiếm các phòng livestream sắp có vòng quay xu...</td></tr>`;
      return;
    }

    tbody.innerHTML = displayRooms.map((room) => {
      const isBlocked = blockedRooms.has(String(room.draw_id));
      const remainingSec = Math.max(0, (room.start_time || 0) - nowSec);
      const avatarUrl = room.cover_pic 
        ? (room.cover_pic.startsWith('http') ? room.cover_pic : `https://down-vn.img.susercontent.com/file/${room.cover_pic}`)
        : 'https://shopee.vn/favicon.ico';
      const shopUrl = `https://live.shopee.vn/pc/live?session=${room.session_id}`;

      let statusHtml = '';
      if (room._result) {
        const isWin = room._result.includes('xu');
        const isErr = room._result.includes('❌') || room._result.includes('⚠️') || room._result.includes('🛑');
        const color = isWin ? '#16a34a' : (isErr ? '#dc2626' : '#2563eb');
        statusHtml = `<div style="font-weight:bold;font-size:13px;color:${color};padding:4px 0;">${room._result}</div>`;
      } else if (isMaxLimitReached) {
        statusHtml = `<div style="color:#64748b;font-size:12px;font-weight:600;">🛑 Đã ngừng (Đạt tối đa giải)</div>`;
      } else if (isBlocked) {
        statusHtml = `<span style="color:#ef4444;font-weight:bold;">🚫 Đã chặn</span> <button class="unblock-btn" data-draw="${room.draw_id}" style="border:none;background:none;cursor:pointer;color:#2563eb;text-decoration:underline;font-size:11px;">Bỏ</button>`;
      } else if (room._playing) {
        statusHtml = `<div style="color:#ea580c;font-weight:bold;font-size:13px;">⚡ Đang quay xu...</div>`;
      } else {
        statusHtml = `
          <div class="status-actions">
            <span class="status-wait">⏳ Chờ</span> <span id="cd-${room.draw_id}" class="countdown-num">${remainingSec}s</span>
            <br>
            <button class="block-btn" data-draw="${room.draw_id}" title="Chặn không tham gia vòng này">🚫</button>
          </div>
        `;
      }

      return `
        <tr id="row-${room.draw_id}">
          <td style="text-align:center;vertical-align:middle;padding:8px 6px;">
            <img src="${avatarUrl}" class="shop-img" onerror="this.src='https://shopee.vn/favicon.ico'"><br>
            <a href="${shopUrl}" target="_blank" class="shop-link" title="${room.nickname || room.username}">${room.nickname || room.username || 'Shop Live'}</a>
          </td>
          <td style="vertical-align:middle;padding:8px 6px;">
            <div class="info-box">
              <span class="info-box-div">🏅 <b>${(room.budget || 0).toLocaleString()} xu</b></span><br>
              <span class="info-box-div" style="color:#64748b;">⏰ ${Clock.formatHHMMSS(room.start_time)}</span>
            </div>
          </td>
          <td id="st-${room.draw_id}" style="text-align:center;vertical-align:middle;padding:8px 6px;">
            ${statusHtml}
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.block-btn').forEach(btn => {
      btn.onclick = () => {
        const drawId = btn.getAttribute('data-draw');
        if (drawId) {
          blockedRooms.add(drawId);
          renderLuckyTable();
        }
      };
    });

    tbody.querySelectorAll('.unblock-btn').forEach(btn => {
      btn.onclick = () => {
        const drawId = btn.getAttribute('data-draw');
        if (drawId) {
          blockedRooms.delete(drawId);
          renderLuckyTable();
        }
      };
    });
  }

  function startLuckyTimer() {
    if (luckyCountdownTimer) clearInterval(luckyCountdownTimer);

    window._slpLuckyTimer = window._slpLuckyTimer = luckyCountdownTimer = setInterval(async () => {
      const nowSec = Clock.nowSec();

      // Kiểm tra nếu đã đạt giới hạn thì dừng
      const wins = getDailyWinsCount();
      const maxWins = Number(settings.maxDailyWins) || 10;
      if (wins >= maxWins && !isMaxLimitReached) {
        stopDueToMaxLimit(`Đã đạt đủ ${wins}/${maxWins} lượt trúng thưởng hôm nay`);
        return;
      }

      for (const room of luckyRooms) {
        if (room._result || blockedRooms.has(String(room.draw_id))) continue;

        const remainingSec = (room.start_time || 0) - nowSec;
        const cdEl = document.getElementById(`cd-${room.draw_id}`);
        if (cdEl && !room._playing) {
          cdEl.textContent = `${Math.max(0, remainingSec)}s`;
        }

        if (isLuckyRunning && !isMaxLimitReached && remainingSec <= luckyPreStartTime && remainingSec >= -15 && !room._played && !room._playing) {
          room._playing = true;
          room._played = true;
          roomStatusMap.set(String(room.draw_id), { played: true, playing: true, result: null });

          const stEl = document.getElementById(`st-${room.draw_id}`);
          if (stEl) stEl.innerHTML = `<div style="color:#ea580c;font-weight:bold;font-size:13px;">⚡ Đang săn xu...</div>`;

          executeLuckyDrawPlay(room);
        }
      }
    }, 500);
  }

  function finalizeRoomResult(room) {
    room._playing = false;
    roomStatusMap.set(String(room.draw_id), { played: true, playing: false, result: room._result });

    const stEl = document.getElementById(`st-${room.draw_id}`);
    if (stEl) {
      const isWin = room._result.includes('xu') || room._result.includes('trúng') || room._result.includes('🎉') || room._result.includes('🎁');
      const isErr = room._result.includes('❌') || room._result.includes('⚠️') || room._result.includes('🛑') || room._result.includes('🚫');
      const color = isWin ? '#16a34a' : (isErr ? '#dc2626' : '#2563eb');
      stEl.innerHTML = `<div style="font-weight:bold;font-size:13px;color:${color};padding:4px 0;">${room._result}</div>`;
    }
  }

  async function executeLuckyDrawPlay(room) {
    const shopName = room.nickname || room.username || `Shop #${room.session_id}`;
    Logger.info(`[Vòng Quay] Chuẩn bị săn xu tại ${shopName} (Draw #${room.draw_id})...`);
    
    if (room.shop_id) {
      ShopeeAPI.followShop(room.session_id, room.shop_id).catch(() => {});
    }

    const stEl = document.getElementById(`st-${room.draw_id}`);
    if (stEl) stEl.innerHTML = `<div style="color:#ea580c;font-weight:bold;font-size:13px;">⚡ Đang săn xu...</div>`;

    let finished = false;
    const startTimeMs = Date.now();
    const timeoutMs = 15000; // Tối đa 15s chờ vòng quay mở

    return new Promise((resolve) => {
      const pollInterval = setInterval(async () => {
        if (finished || isMaxLimitReached || !isLuckyRunning) {
          clearInterval(pollInterval);
          resolve();
          return;
        }

        // Quá thời gian 15s sau khi mở mà Shopee vẫn chưa mở vòng quay
        if (Date.now() - startTimeMs > timeoutMs) {
          clearInterval(pollInterval);
          finished = true;
          room._result = '🛑 Đã kết thúc';
          Logger.warn(`[Vòng Quay] ${shopName}: Quá thời gian chờ vòng quay mở.`);
          finalizeRoomResult(room);
          resolve();
          return;
        }

        try {
          const playRes = await ShopeeAPI.playLuckyDraw(room.session_id, room.draw_id);

          if (playRes?.err_code === 0) {
            // 🎉 TRÚNG THƯỞNG THÀNH CÔNG!
            clearInterval(pollInterval);
            finished = true;

            const prizeAmount = playRes?.data?.prize?.amount || playRes?.data?.coin_count || playRes?.data?.draw_result?.coin_count;
            const prizeName = playRes?.data?.prize?.name || playRes?.data?.prize_name;
            const rewardCoins = parseInt(prizeAmount, 10);

            let rewardText = '🎉 Trúng xu';
            if (!isNaN(rewardCoins) && rewardCoins > 0) {
              rewardText = `🎉 ${rewardCoins} xu`;
              const currentWins = incrementDailyWins();
              Logger.success(`🎉 CHÚC MỪNG: Trúng ${rewardCoins} XU tại ${shopName}! (Lượt trúng #${currentWins})`);
            } else if (prizeName) {
              rewardText = `🎁 ${prizeName}`;
              const currentWins = incrementDailyWins();
              Logger.success(`🎉 CHÚC MỪNG: Trúng ${prizeName} tại ${shopName}! (Lượt trúng #${currentWins})`);
            } else {
              rewardText = '🎉 Trúng thưởng';
              incrementDailyWins();
              Logger.success(`🎉 CHÚC MỪNG: Nhận xu thành công tại ${shopName}!`);
            }

            room._result = rewardText;

            // Kiểm tra giới hạn từ play_info của Shopee
            const playInfo = playRes?.data?.play_info;
            if (playInfo && playInfo.daily_play_times >= playInfo.daily_play_limit) {
              stopDueToMaxLimit(`Shopee báo bạn đã đạt tối đa số lượt lấy giải trong ngày (${playInfo.daily_play_times}/${playInfo.daily_play_limit})`);
            } else {
              const maxWins = Number(settings.maxDailyWins) || 10;
              const currentWins = getDailyWinsCount();
              if (currentWins >= maxWins) {
                stopDueToMaxLimit(`Bạn đã trúng đủ ${currentWins}/${maxWins} giải hôm nay`);
              }
            }

            finalizeRoomResult(room);
            resolve();
            return;
          }

          const errCode = playRes?.err_code || playRes?.error;
          const errMsg = playRes?.err_msg || playRes?.msg || '';

          // 🛑 1. ĐẠT TỐI ĐA LƯỢT TRÚNG GIẢI TRONG NGÀY (Mã 7917030 hoặc 7917015 hoặc 7917025)
          if (errCode === 7917030 || errCode === 7917015 || errCode === 7917025 || errMsg.includes('limit') || errMsg.includes('max') || errMsg.includes('đạt giới hạn')) {
            clearInterval(pollInterval);
            finished = true;
            room._result = '🚫 Đạt tối đa lượt ngày';
            stopDueToMaxLimit('Shopee báo bạn đã đạt tối đa số lượt lấy giải trong ngày (Mã ' + errCode + ')');
            finalizeRoomResult(room);
            resolve();
            return;
          }

          // ⏳ 2. VÒNG QUAY CHƯA MỞ (Chưa tới giây mở của Shopee) -> TIẾP TỤC CHỜ & THỬ LẠI!
          if (errCode === 7917006 || errMsg.includes('not live') || errMsg.includes('not start')) {
            // Shopee chưa mở vòng quay: tiếp tục gửi mỗi 100ms
            return;
          }

          // 🛑 3. HẾT LƯỢT XU / HẾT GIẢI THƯỞNG
          if (errCode === 7917029 || errMsg.includes('fully claim')) {
            clearInterval(pollInterval);
            finished = true;
            room._result = '🛑 Hết giải';
            Logger.warn(`[Vòng Quay] ${shopName}: Đã hết lượt xu giải thưởng.`);
            finalizeRoomResult(room);
            resolve();
            return;
          }

          // ⚠️ 4. CHƯA ĐĂNG NHẬP
          if (errCode === 7917001 || errMsg.includes('login')) {
            clearInterval(pollInterval);
            finished = true;
            room._result = '⚠️ Chưa đăng nhập';
            Logger.error(`[Vòng Quay] Bạn cần đăng nhập tài khoản Shopee trên trình duyệt để quay xu!`);
            finalizeRoomResult(room);
            resolve();
            return;
          }

          // 🛑 5. CÁC MÃ LỖI TERMINAL KHÁC
          if (errCode === 7917003) {
            clearInterval(pollInterval);
            finished = true;
            room._result = '🛑 Không khả dụng';
            Logger.warn(`[Vòng Quay] ${shopName}: Vòng quay không khả dụng.`);
            finalizeRoomResult(room);
            resolve();
            return;
          }

          if (errCode === 7917038) {
            clearInterval(pollInterval);
            finished = true;
            room._result = '🛑 Đã kết thúc';
            Logger.warn(`[Vòng Quay] ${shopName}: Vòng quay đã kết thúc.`);
            finalizeRoomResult(room);
            resolve();
            return;
          }

          if (errCode) {
            clearInterval(pollInterval);
            finished = true;
            room._result = `❌ Lỗi (${errCode})`;
            Logger.warn(`[Vòng Quay] ${shopName}: ${errMsg || `Lỗi mã ${errCode}`}`);
            finalizeRoomResult(room);
            resolve();
            return;
          }
        } catch (e) {
          // Bỏ qua lỗi mạng chập chờn trong 1 nhịp poll để thử lại ở nhịp kế tiếp
        }
      }, 100);
    });
  }

  function toggleLuckyRunning() {
    const btn = document.getElementById('btnToggleRun');

    if (isLuckyRunning) {
      isLuckyRunning = false;
      if (btn) {
        btn.innerHTML = '🚀 Bắt đầu';
        btn.className = 'btn primary';
      }
      if (luckyScanInterval) clearInterval(luckyScanInterval);
      updateStatusDisplay();
      Logger.info('Vòng quay: Đã tạm dừng.');
    } else {
      // Bấm bắt đầu lại sẽ reset cờ giới hạn nếu người dùng muốn thử lại
      isMaxLimitReached = false;
      isLuckyRunning = true;
      if (btn) {
        btn.innerHTML = '🟦 Dừng';
        btn.className = 'btn danger';
      }
      updateStatusDisplay();
      Logger.info(`🚀 Bắt đầu săn vòng quay (${luckyMode}: ${luckyTargetBudget} xu, Bắt đầu: ${luckyPreStartTime}s trước)...`);

      fetchAndRenderLuckyRooms();

      if (luckyScanInterval) clearInterval(luckyScanInterval);
      window._slpScanTimer = window._slpScanTimer = luckyScanInterval = setInterval(() => {
        if (isLuckyRunning && !isMaxLimitReached) fetchAndRenderLuckyRooms();
      }, 15000);
    }
  }

  // ==========================================
  // 6. VOUCHER SCANNER ENGINE (QUÉT VOUCHER LIVE)
  // ==========================================
  let isVoucherRunning = false;
  let voucherTimer = null;
  let claimedVouchers = new Set();

  async function startVoucherScanner() {
    if (isVoucherRunning) return;
    const sessionId = ShopeeAPI.getCurrentSessionId();
    if (!sessionId) {
      Logger.warn('[Quét Voucher] Bạn cần đang ở trong 1 phòng livestream để quét voucher trực tiếp!');
      return;
    }

    isVoucherRunning = true;
    updateVoucherRunButton(true);
    Logger.info(`[Quét Voucher] Bắt đầu quét voucher phòng live session: ${sessionId}`);

    voucherTimer = setInterval(async () => {
      if (!isVoucherRunning) return;
      try {
        const vouchers = await ShopeeAPI.getSessionVouchers(sessionId);
        if (!Array.isArray(vouchers) || vouchers.length === 0) return;

        for (const v of vouchers) {
          const code = v.voucher_code || v.code;
          if (!code || claimedVouchers.has(code)) continue;

          Logger.info(`[Quét Voucher] Phát hiện voucher: [${code}] - Đang lưu vào ví...`);
          const res = await ShopeeAPI.claimVoucher(code, v.promotion_id || v.promotionid, v.signature || '');
          if (res?.error === 0 || res?.data?.status === 1) {
            claimedVouchers.add(code);
            Logger.success(`🎉 LƯU VOUCHER THÀNH CÔNG: [${code}] - Giảm ${v.discount_percentage ? v.discount_percentage + '%' : ''} ${v.discount_value ? v.discount_value + 'k' : ''}`);
          } else {
            Logger.warn(`[Quét Voucher] Voucher [${code}]: ${res?.error_msg || 'Không thể lưu hoặc đã lưu trước đó'}`);
            claimedVouchers.add(code);
          }
        }
      } catch (e) {
        console.warn(e);
      }
    }, (settings.requestDelay || 3) * 1000);
  }

  function stopVoucherScanner() {
    isVoucherRunning = false;
    if (voucherTimer) clearInterval(voucherTimer);
    updateVoucherRunButton(false);
    Logger.info('[Quét Voucher] Đã dừng quét voucher.');
  }

  function updateVoucherRunButton(running) {
    const btn = document.getElementById('run-btn');
    if (!btn) return;
    if (running) {
      btn.innerHTML = '<span>⏹ <b>Dừng Quét</b></span>';
      btn.className = 'btn btn-stop';
    } else {
      btn.innerHTML = '<span>⚡ <b>Voucher</b></span>';
      btn.className = 'btn btn-start';
    }
  }

  // ==========================================
  // 7. PIP MANAGER (PICTURE-IN-PICTURE MINI)
  // ==========================================
  const PiPManager = {
    canvas: null,
    video: null,
    ctx: null,
    logs: [],
    isOpen: false,
    init() {
      if (this.canvas) return;
      this.canvas = document.createElement('canvas');
      this.canvas.width = 480;
      this.canvas.height = 270;
      this.ctx = this.canvas.getContext('2d');
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = this.canvas.captureStream(10);
    },
    addLog(text, type = 'info') {
      this.logs.push({ text, type, time: Date.now() });
      if (this.logs.length > 8) this.logs.shift();
      if (this.isOpen) this.draw();
    },
    draw() {
      if (!this.ctx) return;
      const ctx = this.ctx;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 480, 270);

      ctx.fillStyle = '#f97316';
      ctx.font = 'bold 16px -apple-system, sans-serif';
      ctx.fillText('🎯 Shopee Live Pro Hunter', 14, 26);

      ctx.font = '12px -apple-system, monospace';
      let y = 54;
      for (const log of this.logs) {
        ctx.fillStyle = log.type === 'success' ? '#22c55e' : (log.type === 'warning' ? '#eab308' : '#e2e8f0');
        ctx.fillText(log.text.slice(0, 52), 14, y);
        y += 24;
      }
    },
    async toggle() {
      this.init();
      if (!document.pictureInPictureElement) {
        try {
          await this.video.play();
          await this.video.requestPictureInPicture();
          this.isOpen = true;
          this.draw();
          Logger.info('Đã bật chế độ xem nổi PiP.');
        } catch (e) {
          Logger.warn('Trình duyệt không hỗ trợ PiP: ' + e.message);
        }
      } else {
        document.exitPictureInPicture().catch(() => {});
        this.isOpen = false;
      }
    }
  };

  // ==========================================
  // 8. TẠO GIAO DIỆN (BUILD COMPLETE UI DOM)
  // ==========================================
  function createUI() {
    const shell = document.createElement('div');
    shell.id = 'shopee-live-tools-shell';

    shell.innerHTML = `
      <style>
        #shopee-live-tools-shell {
          position: fixed;
          inset: 0;
          z-index: 999998;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 2vh 2vw;
          box-sizing: border-box;
          background: rgba(0, 0, 0, 0.72);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        }
        #shopee-live-tools-shell, #shopee-live-tools-shell * { box-sizing: border-box; }
        #shopee-live-tools-shell .anm-live-shell-card {
          width: min(1040px, 96vw);
          height: min(860px, 96vh);
          min-height: 400px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.22);
          border-radius: 18px;
          background: #ffffff;
          box-shadow: 0 24px 70px rgba(0,0,0,.55);
        }
        .anm-live-tabs-bar {
          display: flex;
          align-items: center;
          padding: 10px 14px;
          background: #1e293b;
          border-bottom: 1px solid rgba(255,255,255,.1);
          gap: 10px;
        }
        .anm-live-tab {
          padding: 8px 18px;
          border-radius: 8px;
          border: none;
          font-weight: 700;
          font-size: 14px;
          cursor: pointer;
          background: #334155;
          color: #cbd5e1;
          transition: all .15s ease;
        }
        .anm-live-tab.active {
          background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
          color: #ffffff;
          box-shadow: 0 4px 12px rgba(234,88,12,.35);
        }
        .header-actions {
          margin-left: auto;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .header-icon-btn {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          border: none;
          background: #334155;
          color: #ffffff;
          cursor: pointer;
          font-size: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .header-icon-btn:hover { background: #475569; }

        .anm-live-pane {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: #ffffff;
        }
        .anm-live-pane[hidden] { display: none !important; }

        .lucky-toolbar {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
          padding: 12px 18px;
          background: #f0fdf4;
          border-bottom: 1px solid #e2e8f0;
        }
        .budget-toggle {
          padding: 6px 14px;
          border-radius: 6px;
          border: none;
          font-weight: bold;
          font-size: 13px;
          cursor: pointer;
          color: #ffffff;
          background: #0284c7;
        }
        .toolbar-input-group {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .toolbar-input-group label {
          font-size: 12px;
          font-weight: 600;
          color: #475569;
        }
        .toolbar-input {
          width: 85px;
          padding: 6px 10px;
          border: 1px solid #cbd5e1;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          text-align: center;
        }
        .btn {
          padding: 7px 16px;
          border-radius: 6px;
          border: none;
          font-weight: bold;
          font-size: 13px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          transition: all .15s ease;
        }
        .btn.primary { background: #ea580c; color: #fff; }
        .btn.primary:hover { background: #c2410c; }
        .btn.danger { background: #dc2626; color: #fff; }
        .btn.danger:hover { background: #b91c1c; }
        .btn.secondary { background: #64748b; color: #fff; }
        .btn.secondary:hover { background: #475569; }

        .lucky-status-bar {
          padding: 8px 18px;
          background: #f8fafc;
          border-bottom: 1px solid #e2e8f0;
          font-size: 13px;
          font-weight: 600;
          color: #334155;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .lucky-body {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          padding: 14px 18px;
        }
        .lucky-section-title {
          font-size: 15px;
          font-weight: bold;
          color: #1e293b;
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .table-wrap {
          flex: 1;
          overflow-y: auto;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          background: #ffffff;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        thead th {
          position: sticky;
          top: 0;
          background: #f1f5f9;
          color: #334155;
          font-weight: 700;
          padding: 10px 8px;
          border-bottom: 1px solid #cbd5e1;
          text-align: center;
          z-index: 2;
        }
        tbody tr { border-bottom: 1px solid #f1f5f9; }
        tbody tr:hover { background: #f8fafc; }
        .shop-img {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          object-fit: cover;
          border: 1px solid #e2e8f0;
        }
        .shop-link {
          color: #0f172a;
          text-decoration: none;
          font-weight: 600;
          font-size: 12px;
          max-width: 130px;
          display: inline-block;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .shop-link:hover { color: #ea580c; text-decoration: underline; }
        .info-box {
          display: inline-block;
          text-align: left;
        }
        .info-box-div {
          display: inline-block;
          font-size: 12px;
        }
        .status-actions {
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
        }
        .status-wait {
          font-weight: 600;
          color: #475569;
          font-size: 12px;
        }
        .countdown-num {
          font-weight: 700;
          color: #ea580c;
        }
        .block-btn {
          border: 1px solid #cbd5e1;
          background: #f8fafc;
          border-radius: 4px;
          cursor: pointer;
          padding: 2px 6px;
          font-size: 11px;
        }
        .block-btn:hover { background: #fee2e2; border-color: #f87171; }

        .log-box-wrap {
          height: 130px;
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          overflow: hidden;
          background: #0f172a;
        }
        .log-box-header {
          padding: 4px 10px;
          background: #1e293b;
          color: #94a3b8;
          font-size: 11px;
          font-weight: bold;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .log-box-content {
          flex: 1;
          overflow-y: auto;
          padding: 6px 10px;
          font-family: monospace;
          font-size: 11px;
          line-height: 1.4;
          color: #e2e8f0;
        }
        .log-entry { margin-bottom: 2px; word-break: break-all; }
        .log-info { color: #94a3b8; }
        .log-success { color: #4ade80; font-weight: bold; }
        .log-warning { color: #facc15; }
        .log-error { color: #f87171; }

        .scanner-body {
          flex: 1;
          padding: 16px 20px;
          overflow-y: auto;
        }
        .scanner-actions {
          display: flex;
          gap: 10px;
          margin-bottom: 14px;
        }
        .btn-start { background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); color: #fff; }
        .btn-stop { background: #dc2626; color: #fff; }
        .btn-settings { background: #334155; color: #fff; }
        .btn-cart { background: #0284c7; color: #fff; }

        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,.6);
          z-index: 999999;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .modal-card {
          width: min(480px, 92vw);
          background: #fff;
          border-radius: 12px;
          padding: 20px;
          box-shadow: 0 10px 40px rgba(0,0,0,.3);
        }
      </style>

      <div class="anm-live-shell-card">
        <div class="anm-live-tabs-bar">
          <button class="anm-live-tab active" data-tab="lucky">🎯 Vòng Quay</button>
          <button class="anm-live-tab" data-tab="scanner">⚡ Quét Voucher</button>
          <div class="header-actions">
            <button id="header-pip-btn" class="header-icon-btn" title="Mở màn hình nổi PiP">📺</button>
            <button id="header-close-btn" class="header-icon-btn" title="Đóng">✕</button>
          </div>
        </div>

        <section class="anm-live-pane" data-pane="lucky">
          <div class="lucky-toolbar">
            <button id="budgetToggle" class="budget-toggle">MIN</button>
            <div class="toolbar-input-group">
              <label>Số xu:</label>
              <input id="budgetInput" class="toolbar-input" value="5700" placeholder="Xu">
            </div>
            <div class="toolbar-input-group">
              <label>Bắt đầu (s):</label>
              <input id="startTimeInput" class="toolbar-input" value="3" placeholder="3">
            </div>
            <button id="btnToggleRun" class="btn danger">🟦 Dừng</button>
            <button id="btnPiP" class="btn secondary">📺 PiP</button>
          </div>

          <div class="lucky-status-bar">
            <div id="lucky-status-text">Trạng thái: <span style="color:#16a34a;font-weight:bold;">🟢 Đang tự động săn xu</span></div>
            <div style="font-size:12px;color:#64748b;">(Tự động quay & nhận xu khi đến giờ)</div>
          </div>

          <div class="lucky-body">
            <div class="lucky-section-title">🃏 Danh sách vòng chơi</div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width:160px">🏪 Shop</th>
                    <th style="width:140px">ℹ️ Thông tin</th>
                    <th>⚙️ Trạng thái</th>
                  </tr>
                </thead>
                <tbody id="lucky-table-body">
                  <tr>
                    <td colspan="3" style="text-align:center;padding:30px;color:#64748b;">
                      Đang đồng bộ thời gian và tải danh sách phòng live sắp quay xu...
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="log-box-wrap">
              <div class="log-box-header">
                <span>📝 Log hoạt động</span>
                <div>
                  <button id="clear-lucky-log-btn" style="background:none;border:none;color:#94a3b8;cursor:pointer;">🗑 Xóa</button>
                </div>
              </div>
              <div id="lucky-log-container" class="log-box-content"></div>
            </div>
          </div>
        </section>

        <section class="anm-live-pane" data-pane="scanner" hidden>
          <div class="scanner-body">
            <div class="scanner-actions">
              <button id="run-btn" class="btn btn-start"><span>⚡ <b>Voucher</b></span></button>
              <button id="settings-btn" class="btn btn-settings"><span>⚙ <b>Cài đặt</b></span></button>
              <button id="live-cart-btn" class="btn btn-cart"><span>🛒 <b>Giỏ live</b></span></button>
            </div>

            <div class="log-box-wrap" style="height:350px;">
              <div class="log-box-header">
                <span>📋 Log Quét Voucher Live</span>
                <button id="clear-scanner-log-btn" style="background:none;border:none;color:#94a3b8;cursor:pointer;">🗑 Xóa</button>
              </div>
              <div id="scanner-log-container" class="log-box-content"></div>
            </div>
          </div>
        </section>
      </div>
    `;

    document.body.appendChild(shell);

    Logger.register(document.getElementById('lucky-log-container'));
    Logger.register(document.getElementById('scanner-log-container'));

    shell.querySelectorAll('.anm-live-tab').forEach(tab => {
      tab.onclick = () => {
        shell.querySelectorAll('.anm-live-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.getAttribute('data-tab');
        shell.querySelectorAll('.anm-live-pane').forEach(p => {
          if (p.getAttribute('data-pane') === target) p.removeAttribute('hidden');
          else p.setAttribute('hidden', '');
        });
      };
    });

    document.getElementById('header-close-btn').onclick = () => {
      shell.style.display = 'none';
    };

    document.getElementById('header-pip-btn').onclick = () => PiPManager.toggle();
    document.getElementById('btnPiP').onclick = () => PiPManager.toggle();

    const budgetToggle = document.getElementById('budgetToggle');
    budgetToggle.onclick = () => {
      luckyMode = luckyMode === 'MIN' ? 'MAX' : 'MIN';
      budgetToggle.textContent = luckyMode;
      budgetToggle.style.background = luckyMode === 'MIN' ? '#0284c7' : '#9333ea';
      fetchAndRenderLuckyRooms();
    };

    const budgetInput = document.getElementById('budgetInput');
    budgetInput.onchange = () => {
      luckyTargetBudget = Number(budgetInput.value) || 5700;
      fetchAndRenderLuckyRooms();
    };

    const startTimeInput = document.getElementById('startTimeInput');
    startTimeInput.onchange = () => {
      luckyPreStartTime = Number(startTimeInput.value) || 3;
    };

    document.getElementById('btnToggleRun').onclick = toggleLuckyRunning;

    document.getElementById('run-btn').onclick = () => {
      if (isVoucherRunning) stopVoucherScanner();
      else startVoucherScanner();
    };

    document.getElementById('clear-lucky-log-btn').onclick = () => {
      const el = document.getElementById('lucky-log-container');
      if (el) el.innerHTML = '';
    };
    document.getElementById('clear-scanner-log-btn').onclick = () => {
      const el = document.getElementById('scanner-log-container');
      if (el) el.innerHTML = '';
    };

    document.getElementById('settings-btn').onclick = showSettingsModal;
    document.getElementById('live-cart-btn').onclick = showCartModal;

    startLuckyTimer();
  }

  function showSettingsModal() {
    const existing = document.getElementById('slp-settings-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'slp-settings-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h3 style="margin:0;font-size:16px;color:#1e293b;">⚙ Cài đặt Shopee Live Pro</h3>
          <button id="close-modal-btn" style="border:none;background:none;font-size:18px;cursor:pointer;">✕</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;font-size:13px;">
          <div>
            <label style="display:block;margin-bottom:4px;color:#1e293b;font-weight:600;">🛑 Số lượt trúng tối đa mỗi ngày (Tự dừng khi đạt):</label>
            <input type="number" id="cfg-max-wins" value="${settings.maxDailyWins || 10}" min="1" max="50" style="width:100%;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-weight:bold;">
            <div style="font-size:11px;color:#64748b;margin-top:2px;">Mặc định: 10 giải/ngày theo quy định của Shopee.</div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="cfg-tg-enabled" ${settings.telegramEnabled ? 'checked' : ''}>
            <b>Bật thông báo Telegram khi trúng thưởng / đạt giới hạn</b>
          </label>
          <div>
            <label style="display:block;margin-bottom:4px;color:#64748b;">Telegram Bot Token:</label>
            <input type="text" id="cfg-tg-token" value="${settings.telegramToken || ''}" style="width:100%;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;">
          </div>
          <div>
            <label style="display:block;margin-bottom:4px;color:#64748b;">Telegram Chat ID:</label>
            <input type="text" id="cfg-tg-chat" value="${settings.telegramChatId || ''}" style="width:100%;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;">
          </div>
          <label style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="cfg-sound" ${settings.soundEnabled ? 'checked' : ''}>
            <b>Phát âm thanh thông báo khi có kết quả</b>
          </label>
          <div style="margin-top:10px;display:flex;justify-content:flex-end;gap:8px;">
            <button id="save-modal-btn" class="btn primary" style="padding:6px 16px;">Lưu Cài Đặt</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#close-modal-btn').onclick = () => overlay.remove();
    overlay.querySelector('#save-modal-btn').onclick = () => {
      settings.maxDailyWins = Number(overlay.querySelector('#cfg-max-wins').value) || 10;
      settings.telegramEnabled = overlay.querySelector('#cfg-tg-enabled').checked;
      settings.telegramToken = overlay.querySelector('#cfg-tg-token').value.trim();
      settings.telegramChatId = overlay.querySelector('#cfg-tg-chat').value.trim();
      settings.soundEnabled = overlay.querySelector('#cfg-sound').checked;
      saveSettings();
      updateStatusDisplay();
      Logger.success('Đã lưu cấu hình cài đặt.');
      overlay.remove();
    };
  }

  async function showCartModal() {
    const sessionId = ShopeeAPI.getCurrentSessionId();
    if (!sessionId) {
      alert('Vui lòng mở một phòng livestream để xem giỏ hàng!');
      return;
    }

    const existing = document.getElementById('slp-cart-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'slp-cart-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" style="width:min(640px,94vw);max-height:85vh;display:flex;flex-direction:column;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="margin:0;font-size:16px;">🛒 Giỏ hàng Live (Session: ${sessionId})</h3>
          <button id="close-cart-btn" style="border:none;background:none;font-size:18px;cursor:pointer;">✕</button>
        </div>
        <div id="cart-list-container" style="flex:1;overflow-y:auto;max-height:420px;border:1px solid #e2e8f0;border-radius:8px;padding:8px;">
          Đang tải sản phẩm trong giỏ...
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#close-cart-btn').onclick = () => overlay.remove();

    const items = await ShopeeAPI.getLiveCartItems(sessionId);
    const container = overlay.querySelector('#cart-list-container');
    if (!items || items.length === 0) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:#64748b;">Giỏ hàng live trống hoặc không lấy được dữ liệu.</div>';
      return;
    }

    container.innerHTML = items.map(it => `
      <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9;align-items:center;">
        <img src="https://down-vn.img.susercontent.com/file/${it.image}" style="width:48px;height:48px;border-radius:6px;object-fit:cover;">
        <div style="flex:1;font-size:12px;">
          <div style="font-weight:600;margin-bottom:4px;color:#1e293b;">${it.name}</div>
          <div style="color:#ef4444;font-weight:bold;">₫${(it.price / 100000).toLocaleString('vi-VN')}</div>
        </div>
        <a href="https://shopee.vn/product/${it.shop_id}/${it.item_id}" target="_blank" style="padding:4px 10px;background:#ea580c;color:#fff;border-radius:4px;text-decoration:none;font-size:11px;font-weight:bold;">Xem</a>
      </div>
    `).join('');
  }

  // ==========================================
  // 10. KHỞI CHẠY (INITIALIZATION)
  // ==========================================
  createUI();
  updateStatusDisplay();

  Clock.sync().then(() => {
    fetchAndRenderLuckyRooms();
  });

  if (luckyScanInterval) clearInterval(luckyScanInterval);
  window._slpScanTimer = window._slpScanTimer = luckyScanInterval = setInterval(() => {
    if (isLuckyRunning && !isMaxLimitReached) fetchAndRenderLuckyRooms();
  }, 15000);

  Logger.info(`✨ Shopee Live Pro Hunter v2.4 (Fast-Poll 100ms) đã kích hoạt! Giới hạn hôm nay: ${settings.maxDailyWins} giải.`);
})();
