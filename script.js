/* ============================================================
   Khanz094 Audio Space — script.js
   Nguồn dữ liệu: Internet Archive Metadata API (archive.org)
   (Đã thay thế hoàn toàn logic GitHub File API cũ)
============================================================ */

/* ================= 1. CONFIGURATION ================= */
const ARCHIVE_ORG_IDENTIFIER = 'khanz094-audio-space';
const API_BASE_URL = 'https://archive.org/metadata/';
const DOWNLOAD_BASE_URL = 'https://archive.org/download/';

const CACHE_KEY = 'khanz094_archive_cache_v1';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 phút

const PLAYABLE_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg', '.flac'];

// Thời gian "ân hạn" sau khi upload — Archive.org cần vài phút để đồng bộ
// file giữa các server trước khi link tải trực tiếp ổn định. Trong khoảng
// thời gian này, tập mới sẽ bị ẩn khỏi danh sách để tránh người dùng bấm
// trúng và gặp lỗi 404 "giả".
const UPLOAD_GRACE_PERIOD_MS = 15 * 60 * 1000; // 15 phút

// Đếm lượt nghe — Worker Cloudflare tự dựng (không phụ thuộc dịch vụ 3rd-party
// nào nữa, sau khi CounterAPI v1 chết và v2 không ổn định/không rõ hỗ trợ CORS).
// Điền đúng URL Worker của bạn sau khi deploy (dạng https://ten-worker.<subdomain>.workers.dev)
const VIEWS_WORKER_URL = 'https://khanz094-views-worker.khnggmr.workers.dev';

const HISTORY_KEY = 'khanz094_history_v1';
const LIKED_KEY = 'khanz094_liked_v1';
const PLAYLIST_KEY = 'khanz094_playlist_v1';
const HISTORY_LIMIT = 20;
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 ngày

// File "sổ tay đặt tên riêng" — nằm cùng thư mục với index.html trên GitHub.
// Trang admin (sau này) sẽ ghi vào đây; script.js chỉ đọc, không tự ghi.
// Cấu trúc: { "<tên file gốc trên Archive.org>": { "title": "...", "tags": ["...", "..."], "description": "..." } }
const METADATA_OVERRIDES_URL = './metadata-overrides.json';

/* ================= 2. STATE ================= */
let allEpisodes = [];       // Toàn bộ tập, đã chuẩn hoá từ Archive.org
let currentList = [];       // Danh sách đang hiển thị sau filter/sort/search
let episodeViewCountsCache = {}; // { safeName: count } — lấy 1 lần, dùng chung cho sort + hiện trên card
let currentTab = 'all';
let currentTagFilter = null;
let currentTrackIndex = -1;
let isPlaying = false;
let isRepeat = false;
let isAutoNext = true;
let sleepTimerId = null;
let sleepTimerMode = null; // 'off' | minutes | 'end_episode'
let toastTimeoutId = null;

const audio = document.getElementById('main-audio');

/* ================= 3. HELPERS: LOCALSTORAGE ================= */
function getJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}
function setJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* ignore quota errors */ }
}

function getLiked() { return getJSON(LIKED_KEY, []); }
function getPlaylist() { return getJSON(PLAYLIST_KEY, []); }
function getHistory() { return getJSON(HISTORY_KEY, []); }

/* ================= 4. CORE LOGIC: DATA FETCHING (Archive.org) ================= */

/**
 * Lấy danh sách file audio hợp lệ (phần mở rộng cho phép)
 */
function isPlayableFile(fileEntry) {
    const name = (fileEntry.name || '').toLowerCase();
    return PLAYABLE_EXTENSIONS.some(ext => name.endsWith(ext));
}

/**
 * Chuyển 1 phần tử "files" từ Archive.org thành object podcast nội bộ.
 * fileEntry: file GỐC (dùng để lấy title/tag/mtime).
 * playableFileEntry: file THỰC SỰ sẽ dùng để phát (có thể là bản derivative
 * mp3/ogg do Archive.org tự tạo, phát ổn định hơn file gốc .m4a).
 */
function transformFileToEpisode(fileEntry, metadata, index, playableFileEntry, hasDerivative) {
    const rawName = fileEntry.name;
    const dotIndex = rawName.lastIndexOf('.');
    const nameClean = dotIndex > -1 ? rawName.slice(0, dotIndex) : rawName;
    const safeName = nameClean
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

    // Ưu tiên: title riêng của file (nếu có) > tên file (đặc trưng cho từng tập)
    // > tên chung của cả item (chỉ dùng khi không còn cách nào khác)
    const title = fileEntry.title || nameClean || metadata.title;

    let tagSource = fileEntry.subject || metadata.subject || metadata.genre || 'Podcast';
    let tags = Array.isArray(tagSource)
        ? tagSource.map(t => String(t).trim()).filter(Boolean)
        : String(tagSource).split(',').map(t => t.trim()).filter(Boolean);
    if (tags.length === 0) tags = ['Podcast'];

    // Ảnh bìa: ưu tiên ảnh riêng của item trên Archive.org (dùng ảnh __ia_thumb.jpg mặc định)
    const cover = `https://archive.org/services/img/${ARCHIVE_ORG_IDENTIFIER}`;

    const dateSource = fileEntry.mtime ? Number(fileEntry.mtime) * 1000 : Date.parse(metadata.date || metadata.publicdate || '') || 0;

    return {
        filename: rawName,
        safeName: safeName || `episode-${index}`,
        title: title,
        tags: tags,
        cover: cover,
        audioUrl: `${DOWNLOAD_BASE_URL}${ARCHIVE_ORG_IDENTIFIER}/${encodeURIComponent(playableFileEntry.name)}`,
        originalIndex: index,
        date: dateSource || 0,
        length: fileEntry.length ? Number(fileEntry.length) : null,
        hasDerivative: !!hasDerivative,
        originalExt: (rawName.split('.').pop() || '').toLowerCase()
    };
}

/**
 * Đọc cache trong LocalStorage (TTL 10 phút)
 */
function readCache() {
    const cached = getJSON(CACHE_KEY, null);
    if (!cached || !cached.timestamp || !Array.isArray(cached.data)) return null;
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null;
    return cached.data;
}

function writeCache(data) {
    setJSON(CACHE_KEY, { timestamp: Date.now(), data });
}

/**
 * Hàm chính: fetch metadata JSON từ Internet Archive và trả về danh sách episode chuẩn hoá
 */
async function fetchAudioFromArchive() {
    const cached = readCache();
    if (cached) {
        return cached;
    }

    const response = await fetch(`${API_BASE_URL}${ARCHIVE_ORG_IDENTIFIER}`);
    if (!response.ok) {
        throw new Error(`Không thể kết nối Internet Archive (HTTP ${response.status})`);
    }
    const json = await response.json();

    const files = Array.isArray(json.files) ? json.files : [];
    const metadata = json.metadata || {};

    // File audio GỐC do người dùng upload (source: "original")
    const originalAudioFiles = files.filter(f => isPlayableFile(f) && (f.source === 'original' || !f.source));

    // Bản derivative (Archive.org tự tạo, VD mp3/ogg) — thường phát ổn định hơn
    // file gốc, đặc biệt với .m4a. Map theo tên file gốc (`original` field).
    const derivativeMap = {};
    files.filter(f => isPlayableFile(f) && f.source === 'derivative' && f.original).forEach(d => {
        const existing = derivativeMap[d.original];
        // Ưu tiên .mp3 nếu có nhiều derivative cho cùng 1 file gốc
        if (!existing || d.name.toLowerCase().endsWith('.mp3')) {
            derivativeMap[d.original] = d;
        }
    });

    const episodes = originalAudioFiles.map((fileEntry, idx) => {
        const derivative = derivativeMap[fileEntry.name];
        const playableFileEntry = derivative || fileEntry;
        return transformFileToEpisode(fileEntry, metadata, idx, playableFileEntry, !!derivative);
    });

    // Loại trùng theo safeName
    const seen = new Set();
    const uniqueEpisodes = episodes.filter(ep => {
        if (seen.has(ep.safeName)) return false;
        seen.add(ep.safeName);
        return true;
    });

    writeCache(uniqueEpisodes);
    return uniqueEpisodes;
}

/**
 * Đọc file "sổ tay đặt tên riêng" (metadata-overrides.json) — nếu chưa tồn tại
 * hoặc lỗi mạng, coi như chưa có gì tùy chỉnh (trả về object rỗng), KHÔNG
 * chặn web hoạt động bình thường.
 * Luôn fetch mới (không cache), vì file này nhẹ và cần cập nhật ngay khi
 * admin vừa sửa xong.
 */
async function loadMetadataOverrides() {
    try {
        const res = await fetch(`${METADATA_OVERRIDES_URL}?_=${Date.now()}`);
        if (!res.ok) return {};
        const data = await res.json();
        return (data && typeof data === 'object') ? data : {};
    } catch (e) {
        return {};
    }
}

/**
 * Áp đè tên/tag/mô tả tùy chỉnh (nếu có) lên danh sách tập lấy từ Archive.org.
 * Khớp theo `filename` (tên file gốc) — vì đó là thứ không đổi dù Archive.org
 * có tạo thêm derivative hay không.
 */
function applyMetadataOverrides(episodes, overrides) {
    if (!overrides || typeof overrides !== 'object') return episodes;
    return episodes.map(ep => {
        const override = overrides[ep.filename];
        if (!override) return ep;

        // Ưu tiên "tags" (mảng, admin mới) > "tag" (chuỗi đơn, dữ liệu cũ) > tag gốc
        let tags = ep.tags;
        if (Array.isArray(override.tags) && override.tags.length > 0) {
            tags = override.tags;
        } else if (override.tag) {
            tags = [override.tag];
        }

        return {
            ...ep,
            title: override.title || ep.title,
            tags: tags,
            description: override.description || '',
            cover: override.cover || ep.cover
        };
    });
}

/* ================= 5. RENDER: DANH SÁCH TẬP ================= */

function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('vi-VN');
}

function buildTagFilterChips() {
    const wrapper = document.getElementById('tag-filter-wrapper');
    const container = document.getElementById('tag-filter-container');
    const activeDot = document.getElementById('filter-active-dot');

    // Gộp tag trùng nhau dù khác hoa/thường hoặc thừa khoảng trắng
    // (VD "Ngôn tình" và "Ngôn Tình" phải được coi là 1 tag).
    // Giữ lại cách viết xuất hiện ĐẦU TIÊN làm nhãn hiển thị.
    const tagMap = new Map(); // key chuẩn hóa (lowercase, trim) -> nhãn hiển thị gốc
    allEpisodes.forEach(ep => {
        (ep.tags || []).forEach(t => {
            if (!t) return;
            const key = t.trim().toLowerCase();
            if (key && !tagMap.has(key)) {
                tagMap.set(key, t.trim());
            }
        });
    });

    activeDot.classList.toggle('hidden', currentTagFilter === null);

    if (tagMap.size <= 1) {
        wrapper.classList.add('hidden');
        container.innerHTML = '';
        return;
    }

    // Chỉ hiện nút phễu — KHÔNG tự mở panel (giữ nguyên trạng thái đóng/mở
    // hiện tại của người dùng, kể cả khi hàm này được gọi lại sau mỗi lần
    // bấm chọn 1 chip).
    wrapper.classList.remove('hidden');
    container.innerHTML = '';

    const allChip = document.createElement('button');
    allChip.className = 'tag-chip' + (currentTagFilter === null ? ' active' : '');
    allChip.textContent = 'Tất cả chủ đề';
    allChip.addEventListener('click', () => {
        currentTagFilter = null;
        buildTagFilterChips();
        renderEpisodes();
    });
    container.appendChild(allChip);

    tagMap.forEach((label, key) => {
        const chip = document.createElement('button');
        chip.className = 'tag-chip' + (currentTagFilter === key ? ' active' : '');
        chip.textContent = label;
        chip.addEventListener('click', () => {
            currentTagFilter = (currentTagFilter === key) ? null : key;
            buildTagFilterChips();
            renderEpisodes();
        });
        container.appendChild(chip);
    });
}

function isStillProcessing(ep) {
    if (!ep.date) return false; // Không rõ thời gian upload -> coi như đã sẵn sàng
    return (Date.now() - ep.date) < UPLOAD_GRACE_PERIOD_MS;
}

function getFilteredSortedList() {
    let list = [...allEpisodes];

    // Ẩn các tập vừa upload còn trong thời gian đồng bộ với Archive.org
    list = list.filter(ep => !isStillProcessing(ep));

    // Tab: liked / playlist
    if (currentTab === 'liked') {
        const liked = getLiked();
        list = list.filter(ep => liked.includes(ep.safeName));
    } else if (currentTab === 'playlist') {
        const playlist = getPlaylist();
        list = list.filter(ep => playlist.includes(ep.safeName));
    }

    // Tag filter (currentTagFilter là key đã chuẩn hóa: lowercase + trim)
    if (currentTagFilter) {
        list = list.filter(ep => (ep.tags || []).some(t => t.trim().toLowerCase() === currentTagFilter));
    }

    // Search
    const searchInput = document.getElementById('search-input');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (query) {
        list = list.filter(ep =>
            ep.title.toLowerCase().includes(query) ||
            (ep.tags || []).some(t => t.toLowerCase().includes(query))
        );
    }

    // Sort
    const sortSelect = document.getElementById('sort-select');
    const sortMode = sortSelect ? sortSelect.value : 'newest';
    if (sortMode === 'newest') {
        list.sort((a, b) => (b.date || b.originalIndex) - (a.date || a.originalIndex));
    } else if (sortMode === 'oldest') {
        list.sort((a, b) => (a.date || a.originalIndex) - (b.date || b.originalIndex));
    } else if (sortMode === 'az') {
        list.sort((a, b) => a.title.localeCompare(b.title, 'vi'));
    } else if (sortMode === 'views') {
        list.sort((a, b) => (episodeViewCountsCache[b.safeName] || 0) - (episodeViewCountsCache[a.safeName] || 0));
    }

    return list;
}

const EPISODES_PAGE_SIZE = 24;
let visibleEpisodeCount = EPISODES_PAGE_SIZE;

function renderEpisodes({ resetPage = true } = {}) {
    const container = document.getElementById('podcast-list');
    currentList = getFilteredSortedList();
    if (resetPage) visibleEpisodeCount = EPISODES_PAGE_SIZE;

    if (currentList.length === 0) {
        container.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-circle-info"></i> Không tìm thấy tập podcast nào phù hợp.</div>`;
        return;
    }

    const liked = getLiked();
    const playlist = getPlaylist();
    const visibleList = currentList.slice(0, visibleEpisodeCount);
    const remaining = currentList.length - visibleList.length;

    const cardsHtml = visibleList.map(ep => {
        const isLiked = liked.includes(ep.safeName);
        const isInPlaylist = playlist.includes(ep.safeName);
        return `
        <div class="podcast-card" data-safename="${ep.safeName}">
            <div class="card-img">
                <img src="${ep.cover}" alt="${escapeHtml(ep.title)}" loading="lazy" onerror="this.src='https://archive.org/images/notfound.png'">
                <div class="card-actions-overlay">
                    <button class="card-btn-icon like-toggle ${isLiked ? 'liked' : ''}" title="Thích">
                        <i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart"></i>
                    </button>
                    <button class="card-btn-icon playlist-toggle ${isInPlaylist ? 'in-playlist' : ''}" title="Thêm vào danh sách phát">
                        <i class="fa-solid ${isInPlaylist ? 'fa-check' : 'fa-plus'}"></i>
                    </button>
                </div>
                <button class="play-card-btn" title="Phát"><i class="fa-solid fa-play"></i></button>
            </div>
            <div class="card-body">
                <span class="card-tags">${(ep.tags || []).map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join('')}</span>
                <h3>${escapeHtml(ep.title)}</h3>
                <p>${formatDate(ep.date) || 'Khanz094'} <span class="card-views" data-safename="${ep.safeName}"></span></p>
            </div>
        </div>`;
    }).join('');

    const loadMoreHtml = remaining > 0
        ? `<button id="load-more-episodes-btn" class="tag-chip" style="width:100%; margin-top:8px; padding:14px; font-size:0.9rem;">
               <i class="fa-solid fa-chevron-down"></i> Tải thêm (còn ${remaining} tập)
           </button>`
        : '';

    container.innerHTML = cardsHtml + loadMoreHtml;

    // Gắn sự kiện cho từng card
    container.querySelectorAll('.podcast-card').forEach(card => {
        const safeName = card.getAttribute('data-safename');

        card.addEventListener('click', (e) => {
            if (e.target.closest('.like-toggle') || e.target.closest('.playlist-toggle')) return;
            playEpisodeBySafeName(safeName);
        });

        const likeBtn = card.querySelector('.like-toggle');
        likeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleLike(safeName);
        });

        const playlistBtn = card.querySelector('.playlist-toggle');
        playlistBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlaylist(safeName);
        });
    });

    const loadMoreBtn = document.getElementById('load-more-episodes-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => {
            visibleEpisodeCount += EPISODES_PAGE_SIZE;
            renderEpisodes({ resetPage: false });
        });
    }

    // Hiện lượt nghe từ cache đã tải sẵn (không gọi lại API mỗi lần render —
    // đỡ tốn request thừa mỗi khi đổi tab/lọc/tìm kiếm/tải thêm trang).
    container.querySelectorAll('.card-views').forEach(el => {
        const safeName = el.getAttribute('data-safename');
        if (episodeViewCountsCache[safeName] !== undefined) {
            el.textContent = `• ${episodeViewCountsCache[safeName]} lượt nghe`;
        }
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ================= 6. TABS ================= */
function updateTabBadges() {
    document.getElementById('like-count').textContent = getLiked().length;
    document.getElementById('playlist-count').textContent = getPlaylist().length;
}

function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabTitle = document.getElementById('tab-title');
    const tabDesc = document.getElementById('tab-desc');
    const historySection = document.getElementById('history-section');

    const titles = {
        all: { icon: 'fa-list-ul', text: 'Tất Cả Tập Podcast', desc: 'Tự động cập nhật & sắp xếp theo tập mới nhất' },
        liked: { icon: 'fa-heart', text: 'Các Tập Đã Thích', desc: 'Những tập bạn đã đánh dấu yêu thích' },
        playlist: { icon: 'fa-list-check', text: 'Danh Sách Phát Của Bạn', desc: 'Các tập trong danh sách phát riêng' }
    };

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTab = btn.dataset.tab;

            const info = titles[currentTab];
            tabTitle.innerHTML = `<i class="fa-solid ${info.icon} gradient-icon"></i> ${info.text}`;
            tabDesc.textContent = info.desc;

            historySection.classList.toggle('hidden', currentTab !== 'all');

            renderEpisodes();
        });
    });
}

/* ================= 7. LIKE / PLAYLIST ================= */
function toggleLike(safeName) {
    let liked = getLiked();
    if (liked.includes(safeName)) {
        liked = liked.filter(s => s !== safeName);
        showToast('Đã bỏ thích tập này', 'fa-heart-crack');
    } else {
        liked.push(safeName);
        showToast('Đã thêm vào Đã thích', 'fa-heart');
    }
    renderEpisodes({ resetPage: false });
    if (currentTrackIndex > -1) updatePlayerActionStates();
}

function togglePlaylist(safeName) {
    let playlist = getPlaylist();
    if (playlist.includes(safeName)) {
        playlist = playlist.filter(s => s !== safeName);
        showToast('Đã xóa khỏi Danh sách phát', 'fa-list');
    } else {
        playlist.push(safeName);
        showToast('Đã thêm vào Danh sách phát', 'fa-list-check');
    }
    renderEpisodes({ resetPage: false });
    if (currentTrackIndex > -1) updatePlayerActionStates();
}

function updatePlayerActionStates() {
    const ep = allEpisodes[currentTrackIndex];
    if (!ep) return;
    const liked = getLiked();
    const playlist = getPlaylist();
    const likeBtn = document.getElementById('player-like-btn');
    const playlistBtn = document.getElementById('player-playlist-btn');

    const isLiked = liked.includes(ep.safeName);
    const isInPlaylist = playlist.includes(ep.safeName);

    likeBtn.classList.toggle('liked', isLiked);
    likeBtn.innerHTML = `<i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart"></i>`;

    playlistBtn.classList.toggle('in-playlist', isInPlaylist);
    playlistBtn.innerHTML = `<i class="fa-solid ${isInPlaylist ? 'fa-check' : 'fa-plus'}"></i>`;
}

/* ================= 8. TOAST ================= */
function showToast(message, icon = 'fa-circle-check') {
    const toast = document.getElementById('toast-notification');
    const msg = document.getElementById('toast-msg');
    toast.querySelector('i').className = `fa-solid ${icon}`;
    msg.textContent = message;
    toast.classList.remove('hidden');

    if (toastTimeoutId) clearTimeout(toastTimeoutId);
    toastTimeoutId = setTimeout(() => {
        toast.classList.add('hidden');
    }, 2500);
}

/* ================= 9. VIEW COUNTER (Counter API v2) ================= */
function isViewsWorkerConfigured() {
    return VIEWS_WORKER_URL && !VIEWS_WORKER_URL.includes('DÁN_URL_WORKER');
}

let viewsWorkerDebugToastShown = false;
function reportViewsWorkerError(context, detail) {
    console.error(`[ViewsWorker] ${context}:`, detail);
    // Chỉ hiện 1 lần / lần tải trang để không spam, nhưng đủ để chụp màn hình chẩn đoán
    if (!viewsWorkerDebugToastShown) {
        viewsWorkerDebugToastShown = true;
        showToast(`Lỗi đếm lượt nghe (${context}): ${String(detail).slice(0, 80)}`, 'fa-bug');
    }
}

/** Tăng lượt nghe của 1 tập lên 1, gọi khi thực sự mở phát */
async function bumpAndGetViews(safeName) {
    if (!isViewsWorkerConfigured()) {
        reportViewsWorkerError('chưa cấu hình', 'VIEWS_WORKER_URL vẫn là placeholder, chưa dán URL Worker thật');
        return null;
    }
    try {
        const res = await fetch(`${VIEWS_WORKER_URL}/up?ep=${encodeURIComponent(safeName)}`);
        if (res.ok) {
            const data = await res.json();
            return typeof data.count === 'number' ? data.count : null;
        }
        const bodyText = await res.text().catch(() => '(không đọc được nội dung lỗi)');
        reportViewsWorkerError(`HTTP ${res.status}`, bodyText);
    } catch (e) {
        reportViewsWorkerError('lỗi mạng/CORS/fetch', e.message);
    }
    return null;
}

/**
 * Lấy lượt nghe của TẤT CẢ các tập cùng lúc (1 request duy nhất, KHÔNG tăng số)
 * — dùng để hiện lên từng card trong danh sách, tránh gọi API riêng lẻ cho
 * mỗi card gây chậm khi thư viện có nhiều tập.
 */
async function fetchAllViewCounts() {
    if (!isViewsWorkerConfigured()) return {};
    try {
        const res = await fetch(`${VIEWS_WORKER_URL}/counts`);
        if (res.ok) {
            const data = await res.json();
            return (data && typeof data === 'object') ? data : {};
        }
        const bodyText = await res.text().catch(() => '(không đọc được nội dung lỗi)');
        reportViewsWorkerError(`HTTP ${res.status} (counts)`, bodyText);
    } catch (e) {
        reportViewsWorkerError('lỗi mạng/CORS/fetch (counts)', e.message);
    }
    return {};
}

/* ================= 10. MÔ TẢ ================= */
async function loadDescription(ep) {
    const box = document.getElementById('transcript-text');
    if (ep && ep.description) {
        box.innerHTML = `<p style="white-space:pre-wrap;">${escapeHtml(ep.description)}</p>`;
    } else {
        box.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-circle-info"></i> 📝 Chưa có mô tả cho tập này.</div>`;
    }
}

/* ================= 11. PLAYER CORE ================= */
function findIndexInAll(safeName) {
    return allEpisodes.findIndex(ep => ep.safeName === safeName);
}

function playEpisodeBySafeName(safeName) {
    const idx = findIndexInAll(safeName);
    if (idx === -1) return;
    playEpisodeByAllIndex(idx);
}

function playEpisodeByAllIndex(allIndex) {
    const ep = allEpisodes[allIndex];
    if (!ep) return;

    currentTrackIndex = allIndex;

    document.getElementById('player-cover').src = ep.cover;
    document.getElementById('player-title').textContent = ep.title;
    document.getElementById('player-artist').textContent = 'Khanz094';
    document.getElementById('player-tag').textContent = (ep.tags || []).join(', ');

    document.getElementById('mini-cover').src = ep.cover;
    document.getElementById('mini-title').textContent = ep.title;
    document.getElementById('mini-artist').textContent = 'Khanz094';

    const fallbackLink = document.getElementById('player-fallback-link');
    fallbackLink.href = ep.audioUrl;
    fallbackLink.style.display = 'none';

    audio.src = ep.audioUrl;

    // Resume playback nếu có lưu vị trí
    const history = getHistory();
    const historyEntry = history.find(h => h.safeName === ep.safeName);
    const resumeTime = historyEntry ? historyEntry.position : 0;

    audio.addEventListener('loadedmetadata', function onMeta() {
        if (resumeTime && resumeTime < audio.duration - 5) {
            audio.currentTime = resumeTime;
        }
        audio.removeEventListener('loadedmetadata', onMeta);
    });

    audio.play().then(() => {
        isPlaying = true;
        updatePlayIcons();
    }).catch(() => { /* autoplay có thể bị chặn */ });

    openPlayerModal();
    updatePlayerActionStates();
    loadDescription(ep);
    setupMediaSession(ep);
    saveToHistory(ep, resumeTime);
    loadRatingForEpisode(ep.safeName);
    loadCommentsForEpisode(ep.safeName);

    document.getElementById('player-views-count').textContent = '...';
    bumpAndGetViews(ep.safeName).then(count => {
        if (count !== null) {
            document.getElementById('player-views-count').textContent = count;
            episodeViewCountsCache[ep.safeName] = count;
        } else {
            document.getElementById('player-views-count').textContent = '—';
        }
    });
}

function updatePlayIcons() {
    const iconClass = isPlaying ? 'fa-pause' : 'fa-play';
    document.querySelector('#play-btn i').className = `fa-solid ${iconClass}`;
    document.querySelector('#mini-play-btn i').className = `fa-solid ${iconClass}`;
    document.getElementById('playing-badge').style.display = isPlaying ? 'flex' : 'none';
}

function togglePlayPause() {
    if (!audio.src) return;
    if (audio.paused) {
        audio.play();
        isPlaying = true;
    } else {
        audio.pause();
        isPlaying = false;
    }
    updatePlayIcons();
}

function playNext() {
    if (allEpisodes.length === 0) return;
    let nextIndex = currentTrackIndex + 1;
    if (nextIndex >= allEpisodes.length) nextIndex = 0;
    playEpisodeByAllIndex(nextIndex);
}

function playPrevByTrack() {
    if (allEpisodes.length === 0) return;
    let prevIndex = currentTrackIndex - 1;
    if (prevIndex < 0) prevIndex = allEpisodes.length - 1;
    playEpisodeByAllIndex(prevIndex);
}

function playRandomEpisode() {
    if (allEpisodes.length === 0) return;
    let idx;
    do {
        idx = Math.floor(Math.random() * allEpisodes.length);
    } while (allEpisodes.length > 1 && idx === currentTrackIndex);
    playEpisodeByAllIndex(idx);
}

/* ================= 12. MODAL / MINI-PLAYER ================= */
function openPlayerModal() {
    document.getElementById('player-modal').classList.remove('hidden');
    document.getElementById('mini-player').classList.add('hidden');
}
function minimizePlayer() {
    document.getElementById('player-modal').classList.add('hidden');
    if (audio.src) {
        document.getElementById('mini-player').classList.remove('hidden');
    }
}
function stopPlayer() {
    audio.pause();
    audio.currentTime = 0;
    isPlaying = false;
    updatePlayIcons();
    document.getElementById('player-modal').classList.add('hidden');
    document.getElementById('mini-player').classList.add('hidden');
    currentTrackIndex = -1;
}

/* ================= 13. PROGRESS / TIME ================= */
function formatTime(sec) {
    if (!isFinite(sec) || isNaN(sec) || sec < 0) return '00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

audio.addEventListener('timeupdate', () => {
    const progressBar = document.getElementById('progress-bar');
    if (audio.duration) {
        progressBar.value = (audio.currentTime / audio.duration) * 100;
    }
    document.getElementById('current-time').textContent = formatTime(audio.currentTime);
    document.getElementById('duration-time').textContent = formatTime(audio.duration);
});

document.getElementById('progress-bar').addEventListener('input', (e) => {
    if (audio.duration) {
        audio.currentTime = (e.target.value / 100) * audio.duration;
    }
});

audio.addEventListener('error', () => {
    // Bỏ qua lỗi giả khi chưa có tập nào được chọn phát — trình duyệt tự
    // bắn sự kiện "error" ngay lúc tải trang vì thẻ audio có src rỗng ban đầu.
    if (currentTrackIndex === -1 || !audio.src) return;

    const currentEp = allEpisodes[currentTrackIndex];

    // Trường hợp người dùng vào đúng lúc tập vừa upload còn đang đồng bộ
    // (ví dụ qua link chia sẻ trực tiếp, bỏ qua danh sách đã lọc)
    if (currentEp && isStillProcessing(currentEp)) {
        showToast('Tập này vừa tải lên, đang được xử lý — vui lòng thử lại sau ít phút', 'fa-hourglass-half');
        isPlaying = false;
        updatePlayIcons();
        return;
    }

    const err = audio.error;
    let reason = 'Lỗi không xác định';
    if (err) {
        switch (err.code) {
            case err.MEDIA_ERR_ABORTED: reason = 'Phát bị hủy'; break;
            case err.MEDIA_ERR_NETWORK: reason = 'Lỗi mạng khi tải file audio'; break;
            case err.MEDIA_ERR_DECODE: reason = 'File audio bị lỗi định dạng'; break;
            case err.MEDIA_ERR_SRC_NOT_SUPPORTED: reason = 'Trình duyệt không phát được file này qua đường dẫn hiện tại'; break;
        }
    }
    console.error('Audio playback error:', reason, audio.src);
    showToast(`Không phát được: ${reason}. Bạn có thể tải file trực tiếp bên dưới.`, 'fa-triangle-exclamation');

    // Hiện link tải dự phòng để người dùng vẫn nghe được (tải về máy)
    const fallbackLink = document.getElementById('player-fallback-link');
    if (fallbackLink) fallbackLink.style.display = 'inline-flex';

    isPlaying = false;
    updatePlayIcons();
});


audio.addEventListener('ended', () => {
    saveToHistory(allEpisodes[currentTrackIndex], 0, true);
    if (isRepeat) {
        audio.currentTime = 0;
        audio.play();
        return;
    }
    if (sleepTimerMode === 'end_episode') {
        clearSleepTimer();
        isPlaying = false;
        updatePlayIcons();
        return;
    }
    if (isAutoNext) {
        playNext();
    } else {
        isPlaying = false;
        updatePlayIcons();
    }
});

/* Lưu vị trí nghe định kỳ (backup, phòng khi các sự kiện dưới không kịp bắt) */
let saveHistoryInterval = setInterval(() => {
    if (isPlaying && currentTrackIndex > -1 && audio.currentTime > 3) {
        saveToHistory(allEpisodes[currentTrackIndex], audio.currentTime);
    }
}, 5000);

/* Lưu vị trí NGAY khi tạm dừng — không cần chờ tick 5 giây tiếp theo */
audio.addEventListener('pause', () => {
    if (currentTrackIndex > -1 && audio.currentTime > 3 && !audio.ended) {
        saveToHistory(allEpisodes[currentTrackIndex], audio.currentTime);
    }
});

/* Lưu vị trí NGAY khi người dùng chuyển app / tắt màn hình / ẩn tab
   (mobile hay throttle setInterval khi chạy nền, dễ mất tiến trình nếu
   chỉ dựa vào interval) */
function forceSaveCurrentProgress() {
    if (currentTrackIndex > -1 && audio.currentTime > 3 && !audio.ended) {
        saveToHistory(allEpisodes[currentTrackIndex], audio.currentTime);
    }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') forceSaveCurrentProgress();
});
window.addEventListener('pagehide', forceSaveCurrentProgress);
window.addEventListener('beforeunload', forceSaveCurrentProgress);

/* ================= 14. HISTORY ================= */
function saveToHistory(ep, position, completed = false) {
    if (!ep) return;
    let history = getHistory();
    const now = Date.now();

    // audio.duration chỉ đáng tin khi đúng là bài đang phát VÀ đã load xong
    // metadata; nếu không, dùng "length" lấy sẵn từ Archive.org làm dự phòng
    // (tránh lưu 0/NaN vào lịch sử ngay lúc mới bắt đầu phát).
    const isCurrentTrack = allEpisodes[currentTrackIndex] === ep;
    const liveDuration = (isCurrentTrack && isFinite(audio.duration) && audio.duration > 0) ? audio.duration : 0;
    const duration = liveDuration || ep.length || 0;

    history = history.filter(h => now - h.timestamp < HISTORY_TTL_MS);
    history = history.filter(h => h.safeName !== ep.safeName);

    history.unshift({
        safeName: ep.safeName,
        title: ep.title,
        cover: ep.cover,
        position: completed ? 0 : position,
        duration: duration,
        timestamp: now
    });

    history = history.slice(0, HISTORY_LIMIT);
    setJSON(HISTORY_KEY, history);
    renderHistory();
}

function renderHistory() {
    const history = getHistory();
    const section = document.getElementById('history-section');
    const list = document.getElementById('history-list');

    if (history.length === 0 || currentTab !== 'all') {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');

    list.innerHTML = history.map(h => {
        const percent = h.duration ? Math.min(100, (h.position / h.duration) * 100) : 0;
        return `
        <div class="history-card" data-safename="${h.safeName}">
            <img src="${h.cover}" alt="${escapeHtml(h.title)}" onerror="this.src='https://archive.org/images/notfound.png'">
            <div class="history-info">
                <h4>${escapeHtml(h.title)}</h4>
                <p>${formatTime(h.position)} / ${formatTime(h.duration)}</p>
            </div>
            <div class="history-progress-bar" style="width:${percent}%"></div>
        </div>`;
    }).join('');

    list.querySelectorAll('.history-card').forEach(card => {
        card.addEventListener('click', () => {
            playEpisodeBySafeName(card.getAttribute('data-safename'));
        });
    });
}

document.getElementById('clear-history-btn').addEventListener('click', () => {
    setJSON(HISTORY_KEY, []);
    renderHistory();
    showToast('Đã xóa lịch sử nghe', 'fa-trash-can');
});

/* ================= 15. SPEED / SLEEP TIMER ================= */
function setupDropdowns() {
    document.querySelectorAll('.dropdown-wrapper').forEach(wrapper => {
        const btn = wrapper.querySelector('button.extra-btn');
        const menu = wrapper.querySelector('.dropdown-menu');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.dropdown-menu').forEach(m => {
                if (m !== menu) m.classList.add('hidden');
            });
            menu.classList.toggle('hidden');
        });
    });

    // Nút phễu lọc chủ đề — dùng chung cơ chế đóng khi bấm ra ngoài bên dưới
    const tagFilterToggleBtn = document.getElementById('tag-filter-toggle-btn');
    const tagFilterPanel = document.getElementById('tag-filter-container');
    tagFilterToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
        tagFilterPanel.classList.toggle('hidden');
    });
    tagFilterPanel.addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener('click', () => {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
        tagFilterPanel.classList.add('hidden');
    });
}

document.getElementById('speed-menu').addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    const speed = parseFloat(item.dataset.speed);
    audio.playbackRate = speed;
    document.getElementById('speed-text').textContent = `${speed}x`;
    document.querySelectorAll('#speed-menu .menu-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
});

function clearSleepTimer() {
    if (sleepTimerId) {
        clearTimeout(sleepTimerId);
        sleepTimerId = null;
    }
    sleepTimerMode = null;
    document.getElementById('timer-text').textContent = 'Hẹn giờ';
    document.getElementById('timer-btn').classList.remove('active-timer');
    document.querySelectorAll('#timer-menu .menu-item').forEach(i => i.classList.remove('active'));
}

document.getElementById('timer-menu').addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    const value = item.dataset.timer;

    clearSleepTimer();
    document.querySelectorAll('#timer-menu .menu-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    if (value === 'off') {
        showToast('Đã tắt hẹn giờ', 'fa-moon');
        return;
    }

    if (value === 'end_episode') {
        sleepTimerMode = 'end_episode';
        document.getElementById('timer-text').textContent = 'Hết tập';
        document.getElementById('timer-btn').classList.add('active-timer');
        showToast('Sẽ dừng khi hết tập này', 'fa-moon');
        return;
    }

    const minutes = parseInt(value, 10);
    sleepTimerMode = minutes;
    document.getElementById('timer-text').textContent = `${minutes} phút`;
    document.getElementById('timer-btn').classList.add('active-timer');
    sleepTimerId = setTimeout(() => {
        audio.pause();
        isPlaying = false;
        updatePlayIcons();
        clearSleepTimer();
        showToast('Đã tự động dừng theo hẹn giờ', 'fa-moon');
    }, minutes * 60 * 1000);
    showToast(`Đã hẹn giờ tắt sau ${minutes} phút`, 'fa-moon');
});

/* ================= 16. REPEAT / AUTO-NEXT / VOLUME ================= */
document.getElementById('repeat-btn').addEventListener('click', () => {
    isRepeat = !isRepeat;
    document.getElementById('repeat-btn').classList.toggle('active-mode', isRepeat);
    showToast(isRepeat ? 'Đã bật Lặp lại tập này' : 'Đã tắt Lặp lại', 'fa-repeat');
});

document.getElementById('auto-next-btn').addEventListener('click', () => {
    isAutoNext = !isAutoNext;
    document.getElementById('auto-next-btn').classList.toggle('active-mode', isAutoNext);
    showToast(isAutoNext ? 'Đã bật Tự động phát tiếp' : 'Đã tắt Tự động phát tiếp', 'fa-forward-step');
});

let isMuted = false;
document.getElementById('mute-btn').addEventListener('click', () => {
    isMuted = !isMuted;
    audio.muted = isMuted;
    const icon = document.querySelector('#mute-btn i');
    icon.className = `fa-solid ${isMuted ? 'fa-volume-xmark' : 'fa-volume-high'}`;
});

document.getElementById('volume-bar').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    audio.volume = Math.min(Math.max(val, 0), 100) / 100;
    isMuted = val === 0;
    audio.muted = isMuted;
    const icon = document.querySelector('#mute-btn i');
    icon.className = `fa-solid ${isMuted ? 'fa-volume-xmark' : (val < 50 ? 'fa-volume-low' : 'fa-volume-high')}`;
});

/* ================= 17. PLAYER BUTTONS ================= */
document.getElementById('play-btn').addEventListener('click', togglePlayPause);
document.getElementById('mini-play-btn').addEventListener('click', togglePlayPause);
document.getElementById('next-btn').addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });
document.getElementById('prev-btn').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
document.getElementById('minimize-player-btn').addEventListener('click', minimizePlayer);
document.getElementById('stop-player-btn').addEventListener('click', stopPlayer);
document.getElementById('expand-player-btn').addEventListener('click', openPlayerModal);
document.getElementById('mini-close-btn').addEventListener('click', stopPlayer);

document.getElementById('player-like-btn').addEventListener('click', () => {
    const ep = allEpisodes[currentTrackIndex];
    if (ep) toggleLike(ep.safeName);
});
document.getElementById('player-playlist-btn').addEventListener('click', () => {
    const ep = allEpisodes[currentTrackIndex];
    if (ep) togglePlaylist(ep.safeName);
});

/* ================= 18. SHARE ================= */
document.getElementById('player-share-btn').addEventListener('click', () => {
    const ep = allEpisodes[currentTrackIndex];
    if (!ep) return;
    const url = `${window.location.origin}${window.location.pathname}?track=${ep.safeName}`;
    if (navigator.share) {
        navigator.share({ title: ep.title, text: 'Nghe podcast trên Khanz094 Audio Space', url }).catch(() => {});
    } else {
        navigator.clipboard.writeText(url).then(() => {
            showToast('Đã chép liên kết!', 'fa-circle-check');
        }).catch(() => {
            showToast('Không thể chép liên kết', 'fa-triangle-exclamation');
        });
    }
});

/* Xử lý deep-link ?track=safename khi tải trang */
function checkDeepLinkTrack() {
    const params = new URLSearchParams(window.location.search);
    const track = params.get('track');
    if (track) {
        const idx = findIndexInAll(track);
        if (idx > -1) {
            playEpisodeByAllIndex(idx);
        }
    }
}

/* ================= 19. MEDIA SESSION API (Lockscreen) ================= */
function setupMediaSession(ep) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
        title: ep.title,
        artist: 'Khanz094',
        album: 'Khanz094 Audio Space',
        artwork: [
            { src: ep.cover, sizes: '512x512', type: 'image/jpeg' }
        ]
    });

    navigator.mediaSession.setActionHandler('play', () => { audio.play(); isPlaying = true; updatePlayIcons(); });
    navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); isPlaying = false; updatePlayIcons(); });
    navigator.mediaSession.setActionHandler('previoustrack', playPrevByTrack);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
    navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
    navigator.mediaSession.setActionHandler('seekforward', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });
}

/* ================= 20. THEME TOGGLE ================= */
function setupTheme() {
    const btn = document.getElementById('theme-toggle');
    const icon = btn.querySelector('i');
    const saved = localStorage.getItem('khanz094_theme') || 'dark';

    applyTheme(saved);

    btn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        const next = current === 'light' ? 'dark' : 'light';
        applyTheme(next);
        localStorage.setItem('khanz094_theme', next);
    });

    function applyTheme(mode) {
        if (mode === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
            icon.className = 'fa-solid fa-sun';
        } else {
            document.documentElement.removeAttribute('data-theme');
            icon.className = 'fa-solid fa-moon';
        }
    }
}

/* ================= 21. SEARCH / SORT ================= */
function setupSearchSort() {
    document.getElementById('search-input').addEventListener('input', renderEpisodes);
    document.getElementById('sort-select').addEventListener('change', renderEpisodes);
}

/* ================= 22. RANDOM BUTTON ================= */
document.getElementById('random-episode-btn').addEventListener('click', playRandomEpisode);

/* ================= 23. TÀI KHOẢN (Firebase Authentication) ================= */
// UID của tài khoản quản trị — nếu người đang đăng nhập trùng UID này, họ sẽ
// thấy nút xóa trên MỌI bình luận (không chỉ bình luận của chính họ), dùng
// để kiểm duyệt. Lấy UID của bạn tại Firebase Console -> Authentication ->
// Users (sau khi đã đăng ký 1 tài khoản cho chính mình).
const ADMIN_UID = 'DÁN_UID_ADMIN_VÀO_ĐÂY';

let currentFirebaseUser = null;
let isRegisterMode = false;

function translateFirebaseError(code) {
    const map = {
        'auth/email-already-in-use': 'Email này đã được đăng ký.',
        'auth/invalid-email': 'Email không hợp lệ.',
        'auth/weak-password': 'Mật khẩu quá ngắn (tối thiểu 6 ký tự).',
        'auth/user-not-found': 'Không tìm thấy tài khoản với email này.',
        'auth/wrong-password': 'Sai mật khẩu.',
        'auth/invalid-credential': 'Email hoặc mật khẩu không đúng.',
        'auth/too-many-requests': 'Thử sai quá nhiều lần, vui lòng đợi 1 lúc rồi thử lại.',
        'auth/network-request-failed': 'Lỗi kết nối mạng.'
    };
    return map[code] || `Có lỗi xảy ra (${code || 'không rõ'}).`;
}

function updateAuthUI(user) {
    const authBtnIcon = document.querySelector('#auth-btn i');
    const loggedOutView = document.getElementById('auth-logged-out');
    const loggedInView = document.getElementById('auth-logged-in');

    if (user) {
        authBtnIcon.className = 'fa-solid fa-circle-user';
        loggedOutView.classList.add('hidden');
        loggedInView.classList.remove('hidden');
        document.getElementById('auth-current-name').textContent = user.displayName || 'Người dùng';
        document.getElementById('auth-current-email').textContent = user.email || '';
    } else {
        authBtnIcon.className = 'fa-solid fa-user';
        loggedOutView.classList.remove('hidden');
        loggedInView.classList.add('hidden');
    }
    updateCommentFormState();
}

function updateCommentFormState() {
    const input = document.getElementById('comment-input');
    const btn = document.getElementById('comment-submit-btn');
    const ratingHint = document.getElementById('rating-hint');
    if (!input || !btn || !ratingHint) return;

    if (currentFirebaseUser) {
        input.disabled = false;
        input.placeholder = 'Viết bình luận của bạn...';
        btn.disabled = false;
        ratingHint.style.display = 'none';
    } else {
        input.disabled = true;
        input.placeholder = 'Đăng nhập để bình luận...';
        btn.disabled = true;
        ratingHint.style.display = 'block';
    }
}

function setAuthMode(register) {
    isRegisterMode = register;
    document.getElementById('auth-mode-login-btn').classList.toggle('active', !register);
    document.getElementById('auth-mode-register-btn').classList.toggle('active', register);
    document.getElementById('auth-submit-btn').textContent = register ? 'Đăng ký' : 'Đăng nhập';
    document.getElementById('auth-name-field').classList.toggle('hidden', !register);
    document.getElementById('auth-error').classList.add('hidden');
}

function setupAuthModal() {
    const authBtn = document.getElementById('auth-btn');
    const authModal = document.getElementById('auth-modal');
    const closeBtn = document.getElementById('auth-close-btn');
    const submitBtn = document.getElementById('auth-submit-btn');
    const logoutBtn = document.getElementById('auth-logout-btn');
    const errorEl = document.getElementById('auth-error');
    const errorTextEl = errorEl.querySelector('span');

    authBtn.addEventListener('click', () => authModal.classList.remove('hidden'));
    closeBtn.addEventListener('click', () => authModal.classList.add('hidden'));

    document.getElementById('auth-mode-login-btn').addEventListener('click', () => setAuthMode(false));
    document.getElementById('auth-mode-register-btn').addEventListener('click', () => setAuthMode(true));

    submitBtn.addEventListener('click', async () => {
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;
        errorEl.classList.add('hidden');

        if (!email || !password) {
            errorTextEl.textContent = 'Vui lòng nhập đủ email và mật khẩu.';
            errorEl.classList.remove('hidden');
            return;
        }

        submitBtn.disabled = true;
        try {
            if (isRegisterMode) {
                const displayName = document.getElementById('auth-display-name').value.trim();
                const cred = await fbAuth.createUserWithEmailAndPassword(email, password);
                if (displayName) await cred.user.updateProfile({ displayName });
            } else {
                await fbAuth.signInWithEmailAndPassword(email, password);
            }
            authModal.classList.add('hidden');
            document.getElementById('auth-email').value = '';
            document.getElementById('auth-password').value = '';
            document.getElementById('auth-display-name').value = '';
        } catch (err) {
            errorTextEl.textContent = translateFirebaseError(err.code);
            errorEl.classList.remove('hidden');
        } finally {
            submitBtn.disabled = false;
        }
    });

    logoutBtn.addEventListener('click', () => {
        fbAuth.signOut();
        authModal.classList.add('hidden');
    });

    fbAuth.onAuthStateChanged(user => {
        currentFirebaseUser = user;
        updateAuthUI(user);
        if (currentTrackIndex > -1) {
            const ep = allEpisodes[currentTrackIndex];
            if (ep) loadRatingForEpisode(ep.safeName);
        }

    });
}

/* ================= 24. ĐÁNH GIÁ (RATING) ================= */
function highlightStars(value) {
    document.querySelectorAll('#rating-stars i').forEach(star => {
        const starValue = parseInt(star.dataset.value, 10);
        star.className = starValue <= value ? 'fa-solid fa-star' : 'fa-regular fa-star';
    });
}

/**
 * Đọc đánh giá qua bảng tổng hợp (rating_aggregates) — CHỈ 2 lần đọc cố định
 * (1 lần đọc tổng {sum, count} + 1 lần đọc đánh giá riêng của người đang
 * đăng nhập), không phụ thuộc số lượng đánh giá của tập đó là bao nhiêu.
 * Bảng tổng hợp được cập nhật ngay trong lúc gửi đánh giá (xem setupRatingStars).
 */
async function loadRatingForEpisode(safeName) {
    const summaryEl = document.getElementById('rating-summary');
    if (!summaryEl || !isFirebaseConfigured()) return;
    summaryEl.textContent = 'Đang tải đánh giá...';
    highlightStars(0);

    try {
        const aggregateDoc = await fbDb.collection('rating_aggregates').doc(safeName).get();
        const aggData = aggregateDoc.exists ? aggregateDoc.data() : { sum: 0, count: 0 };

        summaryEl.textContent = !aggData.count
            ? 'Chưa có đánh giá nào'
            : `${(aggData.sum / aggData.count).toFixed(1)} / 5 (${aggData.count} lượt đánh giá)`;

        let myValue = 0;
        if (currentFirebaseUser) {
            const myDoc = await fbDb.collection('ratings').doc(`${safeName}_${currentFirebaseUser.uid}`).get();
            if (myDoc.exists) myValue = myDoc.data().value;
        }
        highlightStars(myValue);
    } catch (err) {
        summaryEl.textContent = 'Không tải được đánh giá';
        console.error('[Firestore ratings]', err);
    }
}

let isSavingRating = false;

function setupRatingStars() {
    document.querySelectorAll('#rating-stars i').forEach(star => {
        star.addEventListener('click', async () => {
            if (!isFirebaseConfigured()) {
                showToast('Chưa cấu hình Firebase', 'fa-triangle-exclamation');
                return;
            }
            if (!currentFirebaseUser) {
                document.getElementById('auth-modal').classList.remove('hidden');
                return;
            }
            if (currentTrackIndex === -1) return;
            if (isSavingRating) return; // chặn bấm liên tục khi đang lưu, tránh ghi trùng

            const ep = allEpisodes[currentTrackIndex];
            const value = parseInt(star.dataset.value, 10);
            highlightStars(value); // phản hồi ngay, không đợi mạng
            isSavingRating = true;

            try {
                const ratingRef = fbDb.collection('ratings').doc(`${ep.safeName}_${currentFirebaseUser.uid}`);
                const aggregateRef = fbDb.collection('rating_aggregates').doc(ep.safeName);

                // Dùng transaction để cộng/trừ đúng vào tổng {sum, count} một
                // cách an toàn dù nhiều người cùng đánh giá cùng lúc.
                await fbDb.runTransaction(async (tx) => {
                    const ratingDoc = await tx.get(ratingRef);
                    const aggregateDoc = await tx.get(aggregateRef);

                    const oldValue = ratingDoc.exists ? ratingDoc.data().value : null;
                    const aggData = aggregateDoc.exists ? aggregateDoc.data() : { sum: 0, count: 0 };

                    let newSum = aggData.sum;
                    let newCount = aggData.count;
                    if (oldValue === null) {
                        newSum += value;
                        newCount += 1;
                    } else {
                        newSum += (value - oldValue);
                    }

                    tx.set(ratingRef, {
                        episodeSafeName: ep.safeName,
                        uid: currentFirebaseUser.uid,
                        value: value,
                        timestamp: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    tx.set(aggregateRef, { sum: newSum, count: newCount });
                });

                loadRatingForEpisode(ep.safeName);
            } catch (err) {
                showToast('Không thể lưu đánh giá: ' + err.message, 'fa-triangle-exclamation');
            } finally {
                isSavingRating = false;
            }
        });
    });
}

/* ================= 25. BÌNH LUẬN ================= */
function formatCommentTime(date) {
    return date.toLocaleDateString('vi-VN') + ' ' + date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

const COMMENTS_PAGE_SIZE = 20;
let lastCommentDoc = null;
let currentCommentsSafeName = null;

async function loadCommentsForEpisode(safeName, { loadMore = false } = {}) {
    const listEl = document.getElementById('comment-list');
    if (!listEl || !isFirebaseConfigured()) return;

    if (!loadMore) {
        currentCommentsSafeName = safeName;
        lastCommentDoc = null;
        listEl.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang tải bình luận...</div>`;
    }

    try {
        let query = fbDb.collection('comments')
            .where('episodeSafeName', '==', safeName)
            .orderBy('timestamp', 'desc')
            .limit(COMMENTS_PAGE_SIZE);

        if (loadMore && lastCommentDoc) {
            query = query.startAfter(lastCommentDoc);
        }

        const snapshot = await query.get();

        // Nếu người dùng đã chuyển sang tập khác trong lúc đang tải, bỏ qua
        // kết quả trả về muộn này (tránh hiện nhầm bình luận của tập cũ).
        if (safeName !== currentCommentsSafeName) return;

        if (snapshot.empty && !loadMore) {
            listEl.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem;">Chưa có bình luận nào. Hãy là người đầu tiên!</p>`;
            return;
        }

        if (!loadMore) listEl.innerHTML = '';

        // Xóa nút "tải thêm" cũ trước khi thêm nội dung mới vào cuối
        const oldLoadMoreBtn = document.getElementById('comment-load-more-btn');
        if (oldLoadMoreBtn) oldLoadMoreBtn.remove();

        const itemsHtml = snapshot.docs.map(doc => {
            const data = doc.data();
            const canDelete = currentFirebaseUser && (currentFirebaseUser.uid === data.uid || currentFirebaseUser.uid === ADMIN_UID);
            const timeStr = data.timestamp ? formatCommentTime(data.timestamp.toDate()) : '';
            return `
            <div class="comment-item">
                <div class="comment-header">
                    <strong>${escapeHtml(data.displayName || 'Ẩn danh')}</strong>
                    <span class="comment-time">${timeStr}</span>
                    ${canDelete ? `<button class="comment-delete-btn" data-comment-id="${doc.id}" title="Xóa"><i class="fa-solid fa-trash"></i></button>` : ''}
                </div>
                <p class="comment-text">${escapeHtml(data.text)}</p>
            </div>`;
        }).join('');

        listEl.insertAdjacentHTML('beforeend', itemsHtml);

        listEl.querySelectorAll('.comment-delete-btn:not([data-bound])').forEach(btn => {
            btn.setAttribute('data-bound', '1');
            btn.addEventListener('click', async () => {
                if (!confirm('Xóa bình luận này?')) return;
                try {
                    await fbDb.collection('comments').doc(btn.dataset.commentId).delete();
                    loadCommentsForEpisode(safeName);
                } catch (err) {
                    showToast('Không thể xóa: ' + err.message, 'fa-triangle-exclamation');
                }
            });
        });

        if (snapshot.docs.length > 0) {
            lastCommentDoc = snapshot.docs[snapshot.docs.length - 1];
        }

        // Còn đúng bằng PAGE_SIZE nghĩa là NHIỀU KHẢ NĂNG còn thêm bình luận
        // phía sau — hiện nút tải thêm thay vì tải hết 1 lần.
        if (snapshot.docs.length === COMMENTS_PAGE_SIZE) {
            const btn = document.createElement('button');
            btn.id = 'comment-load-more-btn';
            btn.className = 'tag-chip';
            btn.style.cssText = 'width:100%; margin-top:10px; padding:10px; font-size:0.85rem;';
            btn.innerHTML = '<i class="fa-solid fa-chevron-down"></i> Tải thêm bình luận';
            btn.addEventListener('click', () => loadCommentsForEpisode(safeName, { loadMore: true }));
            listEl.appendChild(btn);
        }
    } catch (err) {
        if (loadMore) {
            showToast('Không tải thêm được bình luận: ' + err.message, 'fa-triangle-exclamation');
        } else {
            listEl.innerHTML = `<p style="color:#fca5a5; font-size:0.85rem;">Không tải được bình luận: ${escapeHtml(err.message)}</p>`;
        }
        console.error('[Firestore comments]', err);
    }
}

function setupCommentForm() {
    document.getElementById('comment-submit-btn').addEventListener('click', async () => {
        if (!isFirebaseConfigured()) {
            showToast('Chưa cấu hình Firebase', 'fa-triangle-exclamation');
            return;
        }
        if (!currentFirebaseUser || currentTrackIndex === -1) return;

        const input = document.getElementById('comment-input');
        const text = input.value.trim();
        if (!text) return;
        if (text.length > 1000) {
            showToast('Bình luận quá dài (tối đa 1000 ký tự)', 'fa-triangle-exclamation');
            return;
        }

        const ep = allEpisodes[currentTrackIndex];
        const btn = document.getElementById('comment-submit-btn');
        btn.disabled = true;

        try {
            await fbDb.collection('comments').add({
                episodeSafeName: ep.safeName,
                uid: currentFirebaseUser.uid,
                displayName: currentFirebaseUser.displayName || (currentFirebaseUser.email ? currentFirebaseUser.email.split('@')[0] : 'Ẩn danh'),
                text: text,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
            input.value = '';
            loadCommentsForEpisode(ep.safeName);
        } catch (err) {
            showToast('Không thể gửi bình luận: ' + err.message, 'fa-triangle-exclamation');
        } finally {
            btn.disabled = false;
        }
    });
}

function isFirebaseConfigured() {
    return window.FIREBASE_CONFIGURED === true;
}

/* ================= 23. INIT ================= */
async function init() {
    setupTabs();
    setupTheme();
    setupSearchSort();
    setupDropdowns();
    updateTabBadges();
    renderHistory();

    if (isFirebaseConfigured()) {
        setupAuthModal();
        setupRatingStars();
        setupCommentForm();
    } else {
        console.warn('Firebase chưa được cấu hình — tính năng đăng nhập/bình luận/đánh giá sẽ không hoạt động. Kiểm tra file firebase-config.js.');
        document.getElementById('auth-btn').addEventListener('click', () => {
            showToast('Tính năng đăng nhập chưa được cấu hình', 'fa-triangle-exclamation');
        });
    }

    const container = document.getElementById('podcast-list');
    try {
        const [rawEpisodes, overrides, viewCounts] = await Promise.all([
            fetchAudioFromArchive(),
            loadMetadataOverrides(),
            fetchAllViewCounts()
        ]);
        allEpisodes = applyMetadataOverrides(rawEpisodes, overrides);
        episodeViewCountsCache = viewCounts;

        if (allEpisodes.length === 0) {
            container.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-triangle-exclamation"></i> Chưa có tập audio nào trên Internet Archive.</div>`;
            return;
        }

        buildTagFilterChips();
        renderEpisodes();
        checkDeepLinkTrack();

        const processingCount = allEpisodes.filter(isStillProcessing).length;
        if (processingCount > 0) {
            showToast(`${processingCount} tập mới đang được xử lý, sẽ xuất hiện sau ít phút`, 'fa-hourglass-half');
        }
    } catch (err) {
        container.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-triangle-exclamation"></i> Lỗi kết nối Internet Archive: ${escapeHtml(err.message)}</div>`;
        console.error('fetchAudioFromArchive error:', err);
    }
}

document.addEventListener('DOMContentLoaded', init);
