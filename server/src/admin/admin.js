/* VibeBuilder Admin — logika halaman. Semua data dari /api/admin/* (nyata).
   Satu halaman per route (body[data-page] menentukan halaman); shell
   (header/sidebar/footer) mengikuti template Metis secara literal.
   Interaksi header/sidebar/tema mengikuti perilaku template yang sama. */
(function () {
  'use strict'

  const $ = (s, r) => (r || document).querySelector(s)
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s))

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  }
  const fmtNum = (n) => Number(n ?? 0).toLocaleString('id-ID')
  const fmtRp = (n) => (n === null || n === undefined ? '–' : `Rp ${fmtNum(n)}`)
  const fmtBytes = (n) => {
    if (!n && n !== 0) return '–'
    if (n < 1024) return `${n} B`
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1048576).toFixed(1)} MB`
  }
  const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–')
  const fmtDateShort = (ts) => (ts ? new Date(ts).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '–')
  function timeAgo(ts) {
    if (!ts) return '–'
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 60) return 'baru saja'
    if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`
    if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`
    return `${Math.floor(s / 86400)} hari lalu`
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...((opts && opts.headers) || {}) },
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { /* bukan JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Permintaan gagal (${res.status}).`)
      err.status = res.status
      throw err
    }
    return data
  }

  function toast(msg, kind) {
    const box = $('#toast-container')
    if (!box) return
    const el = document.createElement('div')
    el.className = `toast align-items-center text-bg-${kind === 'error' ? 'danger' : 'success'} border-0`
    el.setAttribute('role', 'alert')
    el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(msg)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`
    box.appendChild(el)
    const t = new bootstrap.Toast(el, { delay: 4000 })
    t.show()
    el.addEventListener('hidden.bs.toast', () => el.remove())
  }

  let confirmResolve = null
  function confirmDialog(title, text, yesLabel) {
    $('#confirm-title').textContent = title
    $('#confirm-text').textContent = text
    $('#confirm-yes').textContent = yesLabel || 'Ya, lanjutkan'
    const modal = new bootstrap.Modal($('#confirmModal'))
    modal.show()
    return new Promise((resolve) => {
      confirmResolve = (v) => { resolve(v); confirmResolve = null }
    })
  }
  const confirmYes = $('#confirm-yes')
  if (confirmYes) confirmYes.addEventListener('click', () => {
    bootstrap.Modal.getInstance($('#confirmModal')).hide()
    if (confirmResolve) confirmResolve(true)
  })
  const confirmModal = $('#confirmModal')
  if (confirmModal) confirmModal.addEventListener('hidden.bs.modal', () => {
    if (confirmResolve) confirmResolve(false)
  })

  /* ---------- modal form generik ---------- */
  let formResolve = null
  function formDialog(title, fields, values) {
    $('#form-title').textContent = title
    $('#form-body').innerHTML = fields.map((f) => {
      const val = values && values[f.name] !== undefined ? values[f.name] : (f.value ?? '')
      const help = f.help ? `<div class="form-text">${esc(f.help)}</div>` : ''
      if (f.type === 'textarea') {
        return `<div class="mb-3"><label class="form-label" for="form-${esc(f.name)}">${esc(f.label)}</label><textarea class="form-control" id="form-${esc(f.name)}" rows="${f.rows || 3}">${esc(val)}</textarea>${help}</div>`
      }
      return `<div class="mb-3"><label class="form-label" for="form-${esc(f.name)}">${esc(f.label)}</label><input type="${esc(f.type || 'text')}" class="form-control" id="form-${esc(f.name)}" value="${esc(val)}"${f.min !== undefined ? ` min="${f.min}"` : ''}${f.required ? ' required' : ''}>${help}</div>`
    }).join('')
    const modal = new bootstrap.Modal($('#formModal'))
    modal.show()
    return new Promise((resolve) => {
      formResolve = (v) => { resolve(v); formResolve = null }
    })
  }
  const formSave = $('#form-save')
  if (formSave) formSave.addEventListener('click', () => {
    if (!formResolve) return
    const out = {}
    $$('#form-body input, #form-body textarea').forEach((el) => {
      const name = el.id.replace(/^form-/, '')
      out[name] = el.type === 'number' ? Number(el.value) : el.value
    })
    bootstrap.Modal.getInstance($('#formModal')).hide()
    formResolve(out)
  })
  const formModal = $('#formModal')
  if (formModal) formModal.addEventListener('hidden.bs.modal', () => {
    if (formResolve) formResolve(null)
  })

  /* ---------- tema (ala ThemeManager template) ---------- */
  function storedTheme() {
    try {
      return localStorage.getItem('theme') || localStorage.getItem('vb-admin-theme') || null
    } catch { return null }
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme)
    try { localStorage.setItem('theme', theme) } catch { /* abaikan */ }
  }
  function toggleTheme() {
    applyTheme(document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark')
  }
  // Pengaman bila Alpine gagal dimuat: tombol tema tetap bekerja.
  setTimeout(() => {
    if (window.Alpine) return
    const btn = document.querySelector('[x-data="themeSwitch"] button')
    if (btn) btn.addEventListener('click', toggleTheme)
  }, 1500)

  /* ---------- sidebar (ala SidebarManager template) ---------- */
  const MOBILE_BP = 992
  const wrapper = $('#admin-wrapper')
  const sidebar = $('#admin-sidebar')
  const sidebarToggle = document.querySelector('[data-sidebar-toggle]')
  const backdrop = document.querySelector('.sidebar-backdrop')
  function isMobile() { return window.innerWidth < MOBILE_BP }
  function syncSidebarAria() {
    if (!sidebarToggle || !sidebar) return
    const expanded = isMobile()
      ? sidebar.classList.contains('show')
      : !wrapper.classList.contains('sidebar-collapsed')
    sidebarToggle.setAttribute('aria-expanded', String(expanded))
  }
  function initSidebar() {
    if (!wrapper || !sidebar || !sidebarToggle) return
    if (!isMobile()) {
      let collapsed = false
      try { collapsed = localStorage.getItem('sidebar-collapsed') === 'true' } catch { /* abaikan */ }
      if (collapsed) {
        wrapper.classList.add('sidebar-collapsed')
        sidebarToggle.classList.add('is-active')
      }
    }
    sidebarToggle.addEventListener('click', () => {
      if (isMobile()) {
        if (sidebar.classList.contains('show')) closeMobileSidebar()
        else {
          sidebar.classList.add('show')
          if (backdrop) backdrop.classList.add('show')
          document.body.style.overflow = 'hidden'
        }
      } else {
        const collapsed = wrapper.classList.toggle('sidebar-collapsed')
        sidebarToggle.classList.toggle('is-active', collapsed)
        try { localStorage.setItem('sidebar-collapsed', String(collapsed)) } catch { /* abaikan */ }
      }
      syncSidebarAria()
    })
    if (backdrop) backdrop.addEventListener('click', closeMobileSidebar)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isMobile() && sidebar.classList.contains('show')) closeMobileSidebar()
    })
    let resizeTimer = null
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (!isMobile()) {
          sidebar.classList.remove('show')
          if (backdrop) backdrop.classList.remove('show')
          document.body.style.overflow = ''
        }
        syncSidebarAria()
      }, 150)
    })
    syncSidebarAria()
  }
  function closeMobileSidebar() {
    if (!sidebar) return
    sidebar.classList.remove('show')
    if (backdrop) backdrop.classList.remove('show')
    document.body.style.overflow = ''
    syncSidebarAria()
  }
  initSidebar()

  /* ---------- fullscreen + Ctrl+K (ala main.js template) ---------- */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fullscreen-toggle]')
    if (!btn) return
    e.preventDefault()
    try {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen()
      else document.exitFullscreen()
    } catch { /* abaikan */ }
  })
  document.addEventListener('keydown', (e) => {
    const isSearch = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey &&
      (e.code === 'KeyK' || e.key === 'k' || e.key === 'K')
    if (!isSearch) return
    const input = document.querySelector('[data-search-input]')
    if (!input) return
    e.preventDefault()
    input.focus()
  })

  /* ---------- komponen Alpine header (data nyata, bukan demo) ---------- */
  const ADMIN_PAGES = [
    { title: 'Dashboard', url: '/admin', type: 'halaman' },
    { title: 'Pengguna', url: '/admin/users', type: 'halaman' },
    { title: 'Proyek', url: '/admin/projects', type: 'halaman' },
    { title: 'Plan', url: '/admin/plans', type: 'halaman' },
    { title: 'Kelola Credit', url: '/admin/credits', type: 'halaman' },
    { title: 'Penggunaan', url: '/admin/usage', type: 'halaman' },
    { title: 'Biaya LLM', url: '/admin/biaya', type: 'halaman' },
    { title: 'Build', url: '/admin/builds', type: 'halaman' },
    { title: 'Domain', url: '/admin/domain', type: 'halaman' },
    { title: 'Pesan', url: '/admin/messages', type: 'halaman' },
    { title: 'Moderasi', url: '/admin/moderasi', type: 'halaman' },
    { title: 'Pengumuman', url: '/admin/pengumuman', type: 'halaman' },
    { title: 'Sesi', url: '/admin/sessions', type: 'halaman' },
    { title: 'Kesehatan Sistem', url: '/admin/health', type: 'halaman' },
    { title: 'Cadangan & Pulihkan', url: '/admin/cadangan', type: 'halaman' },
    { title: 'Pembersihan', url: '/admin/pembersihan', type: 'halaman' },
    { title: 'Pemeliharaan', url: '/admin/pemeliharaan', type: 'halaman' },
    { title: 'Log Audit', url: '/admin/audit', type: 'halaman' },
    { title: 'Pengaturan AI', url: '/admin/ai-settings', type: 'halaman' },
    { title: 'Pengaturan', url: '/admin/settings', type: 'halaman' },
  ]
  document.addEventListener('alpine:init', () => {
    window.Alpine.data('searchComponent', () => ({
      query: '',
      results: [],
      search() {
        if (this.query.length < 2) { this.results = []; return }
        const q = this.query.toLowerCase()
        this.results = ADMIN_PAGES
          .filter((p) => p.title.toLowerCase().includes(q))
          .slice(0, 6)
      },
    }))
    window.Alpine.data('themeSwitch', () => ({
      currentTheme: 'light',
      init() {
        this.currentTheme = storedTheme() ||
          (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      },
      toggle() {
        this.currentTheme = this.currentTheme === 'light' ? 'dark' : 'light'
        applyTheme(this.currentTheme)
      },
    }))
  })

  /* ---------- grafik ---------- */
  const charts = {}
  function makeChart(id, config) {
    const canvas = document.getElementById(id)
    if (!canvas || typeof Chart === 'undefined') return
    const wrap = canvas.parentElement
    wrap.style.position = 'relative'
    if (!wrap.style.height) wrap.style.height = '300px'
    if (charts[id]) charts[id].destroy()
    charts[id] = new Chart(canvas, config)
  }
  const chartColors = { blue: '#2563eb', green: '#16a34a', amber: '#d97706', red: '#dc2626', slate: '#64748b', teal: '#0d9488' }

  /* ---------- pemuatan data ---------- */
  let overviewCache = null

  async function loadPage(name, ov) {
    if (name === 'dashboard') await loadDashboard(ov)
    else if (name === 'users') await loadUsers()
    else if (name === 'projects') await loadProjects()
    else if (name === 'moderasi') await loadModeration()
    else if (name === 'domain') await loadDomains()
    else if (name === 'plans') await loadPlans()
    else if (name === 'credits') await loadCredits()
    else if (name === 'usage') await loadUsage()
    else if (name === 'biaya') await loadCost()
    else if (name === 'builds') await loadBuilds()
    else if (name === 'messages') await loadMessages()
    else if (name === 'pemeliharaan') await loadMaintenance()
    else if (name === 'pengumuman') await loadAnnouncements()
    else if (name === 'sessions') await loadSessions()
    else if (name === 'health') await loadHealth()
    else if (name === 'cadangan') await loadBackup()
    else if (name === 'pembersihan') await loadCleanup()

    else if (name === 'audit') await loadAudit()
    else if (name === 'ai-settings') await loadAiSettings()
    else if (name === 'settings') await loadSettings()
  }

  function fillNavBadges(ov) {
    const u = $('#nav-users-count')
    if (u) u.textContent = fmtNum(ov.users.total)
    const p = $('#nav-projects-count')
    if (p) p.textContent = fmtNum(ov.projects.total)
  }

  /* Peringatan kesehatan aktif (FITUR 10) tampil di atas daftar aktivitas;
     badge lonceng menghitung peringatan + aktivitas. Gagal memuat alert
     tidak boleh menghilangkan notifikasi aktivitas. */
  async function fillNotifications(ov) {
    const menu = $('#notifications-menu')
    const badge = $('#notif-badge')
    if (!menu) return
    const items = (ov.recent || []).slice(0, 5)
    let alerts = []
    try {
      const data = await api('/api/admin/alerts')
      alerts = data.alerts || []
    } catch { /* abaikan — aktivitas tetap tampil */ }
    const total = alerts.length + items.length
    if (badge) {
      badge.textContent = String(total)
      badge.classList.toggle('d-none', total === 0)
    }
    const alertHtml = alerts.length
      ? '<li><h6 class="dropdown-header text-warning"><i class="bi bi-exclamation-triangle me-1"></i>Peringatan</h6></li>' +
        alerts.map((a) => `<li><a class="dropdown-item" href="/admin/health"><i class="bi bi-exclamation-triangle me-2 ${a.level === 'critical' ? 'text-danger' : 'text-warning'}"></i>${esc(a.message)}<br><small class="text-muted">${esc(timeAgo(a.at))}</small></a></li>`).join('') +
        '<li><hr class="dropdown-divider"></li>'
      : ''
    menu.innerHTML = '<li><h6 class="dropdown-header">Notifikasi</h6></li>' + alertHtml +
      (items.length
        ? items.map((r) => {
            const icon = r.kind === 'user' ? 'bi-person-plus' : r.kind === 'project' ? 'bi-box' : 'bi-hammer'
            return `<li><a class="dropdown-item" href="/admin"><i class="bi ${icon} me-2"></i>${esc(r.text)}<br><small class="text-muted">${esc(timeAgo(r.at))}</small></a></li>`
          }).join('') +
          '<li><hr class="dropdown-divider"></li><li><a class="dropdown-item text-center" href="/admin">Lihat semua aktivitas</a></li>'
        : '<li><a class="dropdown-item text-muted" href="/admin">Belum ada aktivitas.</a></li>')
  }

  async function loadDashboard(ov) {
    const usage = await api('/api/admin/usage')
    overviewCache = ov
    $('#stat-users').textContent = fmtNum(ov.users.total)
    $('#stat-users-sub').textContent = `+${fmtNum(ov.users.new7d)} dalam 7 hari · ${fmtNum(ov.users.disabled)} nonaktif`
    $('#stat-projects').textContent = fmtNum(ov.projects.total)
    $('#stat-projects-sub').textContent = `${fmtNum(ov.projects.published)} diterbitkan · +${fmtNum(ov.projects.new7d)} dalam 7 hari`
    $('#stat-messages').textContent = fmtNum(ov.messages.total)
    $('#stat-messages-sub').textContent = `${fmtNum(ov.messages.today)} hari ini · ${fmtNum(ov.messages.last7d)} dalam 7 hari`
    const tokens = ov.usage.promptTokens + ov.usage.completionTokens
    $('#stat-tokens').textContent = fmtNum(tokens)
    $('#stat-tokens-sub').textContent = `${fmtNum(ov.usage.requests)} permintaan · sejak server start`
    const subtitle = $('#dashboard-subtitle')
    if (subtitle) subtitle.textContent = `Diperbarui ${new Date().toLocaleTimeString('id-ID')} · semua angka dari database`

    const labels = usage.daily.map((d) => d.date.slice(5))
    makeChart('messagesChart', {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Pesan', data: usage.daily.map((d) => d.messages), borderColor: chartColors.blue, backgroundColor: 'rgba(37,99,235,.12)', fill: true, tension: 0.3 },
        { label: 'Proyek baru', data: usage.daily.map((d) => d.projects), borderColor: chartColors.green, tension: 0.3 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
    })

    const feed = $('#activity-feed')
    if (feed) {
      feed.innerHTML = ov.recent.length
        ? ov.recent.map((r) => {
            const icon = r.kind === 'user' ? 'bi-person-plus' : r.kind === 'project' ? 'bi-box' : 'bi-hammer'
            return `<div class="activity-item"><div class="activity-icon"><i class="bi ${icon}"></i></div><div class="activity-content"><p class="mb-1">${esc(r.text)}</p><small class="text-muted">${esc(timeAgo(r.at))}</small></div></div>`
          }).join('')
        : '<p class="text-muted mb-0">Belum ada aktivitas.</p>'
    }

    const statusEntries = Object.entries(ov.projects.byStatus || {})
    makeChart('statusChart', {
      type: 'doughnut',
      data: { labels: statusEntries.map(([k]) => k), datasets: [{ data: statusEntries.map(([, v]) => v), backgroundColor: [chartColors.blue, chartColors.green, chartColors.amber, chartColors.red, chartColors.slate] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
    })

    const topBody = $('#top-users-body')
    if (topBody) {
      topBody.innerHTML = ov.topUsers.length
        ? ov.topUsers.map((u) => `<tr><td><div class="d-flex align-items-center gap-2"><span class="avatar-sm">${esc((u.name || u.email || '?').trim().charAt(0).toUpperCase())}</span><span>${esc(u.name || u.email)}<br><small class="text-muted">${esc(u.email)}</small></span></div></td><td>${fmtNum(u.projects)}</td><td>${fmtNum(u.messages)}</td></tr>`).join('')
        : '<tr><td colspan="3" class="text-muted">Belum ada data.</td></tr>'
    }
  }

  async function loadUsers() {
    const data = await api('/api/admin/users')
    $('#users-subtitle').textContent = `${fmtNum(data.users.length)} akun terdaftar`
    $('#users-body').innerHTML = data.users.map((u) => {
      const isSelf = u.email.toLowerCase() === (window.__vbAdminMe || '').toLowerCase()
      const status = u.isAdmin
        ? '<span class="badge bg-primary">Admin</span>'
        : u.disabled ? '<span class="badge bg-secondary">Nonaktif</span>' : '<span class="badge bg-success">Aktif</span>'
      return `<tr>
        <td><div class="d-flex align-items-center gap-2"><span class="avatar-sm">${esc((u.name || u.email).trim().charAt(0).toUpperCase())}</span><span>${esc(u.name || '')}<br><small class="text-muted">${esc(u.email)}</small></span></div></td>
        <td>${esc(fmtDateShort(u.created_at))}</td>
        <td>${fmtNum(u.projects)}</td>
        <td>${fmtNum(u.messages)}</td>
        <td>${fmtNum(u.tokens)}</td>
        <td>${u.plan_name ? `<span class="badge bg-info">${esc(u.plan_name)}</span>` : '<span class="text-muted">–</span>'}</td>
        <td>${esc(timeAgo(u.last_seen))}</td>
        <td>${status}</td>
        <td class="text-end text-nowrap">
          ${isSelf ? '<span class="text-muted small">akun ini</span>' : `
          <button class="btn btn-sm btn-outline-warning" data-act="toggle-disable" data-id="${esc(u.id)}" data-disabled="${u.disabled ? 0 : 1}" data-email="${esc(u.email)}">${u.disabled ? 'Aktifkan' : 'Nonaktifkan'}</button>
          <button class="btn btn-sm btn-outline-danger" data-act="delete-user" data-id="${esc(u.id)}" data-email="${esc(u.email)}">Hapus</button>`}
        </td>
      </tr>`
    }).join('')
    $$('#users-body [data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const email = btn.dataset.email
      if (btn.dataset.act === 'toggle-disable') {
        const disable = btn.dataset.disabled === '1'
        const ok = await confirmDialog(disable ? 'Nonaktifkan akun' : 'Aktifkan akun', `${disable ? 'Nonaktifkan' : 'Aktifkan'} akun ${email}?${disable ? ' Akun tidak bisa masuk sampai diaktifkan lagi.' : ''}`, disable ? 'Ya, nonaktifkan' : 'Ya, aktifkan')
        if (!ok) return
        try {
          await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ disabled: disable }) })
          toast(`Akun ${email} ${disable ? 'dinonaktifkan' : 'diaktifkan'}.`)
          loadUsers()
        } catch (err) { toast(err.message, 'error') }
      } else {
        const ok = await confirmDialog('Hapus pengguna', `Hapus akun ${email} beserta SEMUA proyeknya? Tindakan ini tidak bisa dibatalkan.`, 'Ya, hapus')
        if (!ok) return
        try {
          const res = await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
          toast(`Akun ${email} dihapus (${fmtNum(res.deletedProjects)} proyek ikut terhapus).`)
          loadUsers()
        } catch (err) { toast(err.message, 'error') }
      }
    }))
  }

  async function loadProjects() {
    const data = await api('/api/admin/projects')
    $('#projects-subtitle').textContent = `${fmtNum(data.projects.length)} proyek dari semua pengguna`
    const statusBadge = (s) => {
      const map = { idle: 'bg-success', working: 'bg-primary', building: 'bg-warning', error: 'bg-danger' }
      return `<span class="badge ${map[s] || 'bg-secondary'}">${esc(s)}</span>`
    }
    $('#projects-body').innerHTML = data.projects.map((p) => `<tr>
      <td><strong>${esc(p.name)}</strong><br><small class="text-muted font-monospace">${esc(p.id)}</small></td>
      <td>${esc(p.owner_email || 'tanpa pemilik')}</td>
      <td>${statusBadge(p.status)}</td>
      <td>${fmtNum(p.messages)}</td>
      <td>${fmtNum(p.files)}</td>
      <td>${p.slug ? `<a href="/p/${esc(p.slug)}" target="_blank" rel="noopener">${esc(p.slug)}</a>` : '<span class="text-muted">–</span>'}</td>
      <td>${esc(fmtDateShort(p.updated_at))}</td>
      <td class="text-end text-nowrap">
        <a class="btn btn-sm btn-outline-primary" href="/proyek/${esc(p.id)}">Buka</a>
        <button class="btn btn-sm btn-outline-danger" data-act="delete-project" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Hapus</button>
      </td>
    </tr>`).join('')
    $$('#projects-body [data-act="delete-project"]').forEach((btn) => btn.addEventListener('click', async () => {
      const ok = await confirmDialog('Hapus proyek', `Hapus proyek "${btn.dataset.name}" beserta semua file, pesan, dan build-nya? Tindakan ini tidak bisa dibatalkan.`, 'Ya, hapus')
      if (!ok) return
      try {
        await api(`/api/admin/projects/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' })
        toast('Proyek dihapus.')
        loadProjects()
      } catch (err) { toast(err.message, 'error') }
    }))
  }

  /* ---------- FITUR 3 — moderasi ---------- */
  async function loadModeration() {
    const data = await api('/api/admin/moderation')
    const flagged = data.projects.filter((p) => p.flagged).length
    const suspended = data.projects.filter((p) => p.suspended).length
    $('#moderation-subtitle').textContent = `${fmtNum(data.projects.length)} proyek · ${fmtNum(flagged)} ditandai · ${fmtNum(suspended)} ditangguhkan`
    const statusBadge = (s) => {
      const map = { idle: 'bg-success', working: 'bg-primary', building: 'bg-warning', error: 'bg-danger' }
      return `<span class="badge ${map[s] || 'bg-secondary'}">${esc(s)}</span>`
    }
    $('#moderation-body').innerHTML = data.projects.length
      ? data.projects.map((p) => `<tr>
        <td><strong>${esc(p.name)}</strong><br><small class="text-muted font-monospace">${esc(p.id)}</small></td>
        <td>${esc(p.owner_email || 'tanpa pemilik')}</td>
        <td>${statusBadge(p.status)}</td>
        <td>${p.flagged
          ? `<span class="badge bg-warning text-dark">Ditandai</span><br><small class="text-muted">${esc(p.flag_reason)}</small><br><small class="text-muted">oleh ${esc(p.flag_by || '–')} · ${esc(fmtDateShort(p.flagged_at))}</small>`
          : '<span class="text-muted">–</span>'}</td>
        <td>${p.suspended ? '<span class="badge bg-danger">Ditangguhkan</span>' : '<span class="badge bg-success">Aktif</span>'}</td>
        <td class="text-nowrap"><a href="/proyek/${esc(p.id)}">Buka</a>${p.slug ? ` · <a href="/p/${esc(p.slug)}" target="_blank" rel="noopener">Terbit</a>` : ''}</td>
        <td class="text-end text-nowrap">
          ${p.flagged
            ? `<button class="btn btn-sm btn-outline-secondary" data-act="unflag" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Hapus tanda</button>`
            : `<button class="btn btn-sm btn-outline-warning" data-act="flag" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Tandai</button>`}
          ${p.suspended
            ? `<button class="btn btn-sm btn-outline-success" data-act="unsuspend" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Buka penangguhan</button>`
            : `<button class="btn btn-sm btn-outline-danger" data-act="suspend" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Tangguhkan</button>`}
        </td>
      </tr>`).join('')
      : '<tr><td colspan="7" class="text-muted">Belum ada proyek.</td></tr>'
    $$('#moderation-body [data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const name = btn.dataset.name
      try {
        if (btn.dataset.act === 'flag') {
          const vals = await formDialog('Tandai proyek', [
            { name: 'reason', label: 'Alasan penandaan', type: 'textarea', required: true, help: 'Alasan ini terlihat oleh admin lain di tabel moderasi.' },
          ], {})
          if (!vals || !String(vals.reason || '').trim()) return
          await api(`/api/admin/projects/${encodeURIComponent(id)}/flag`, { method: 'POST', body: JSON.stringify({ reason: vals.reason }) })
          toast(`Proyek "${name}" ditandai.`)
        } else if (btn.dataset.act === 'unflag') {
          const ok = await confirmDialog('Hapus tanda', `Hapus tanda pada proyek "${name}"?`, 'Ya, hapus tanda')
          if (!ok) return
          await api(`/api/admin/projects/${encodeURIComponent(id)}/flag`, { method: 'DELETE' })
          toast('Tanda dihapus.')
        } else if (btn.dataset.act === 'suspend') {
          const ok = await confirmDialog('Tangguhkan proyek', `Tangguhkan proyek "${name}"? Preview yang sedang berjalan dihentikan. Catatan: preview/publish di jalur publik belum diblokir otomatis sampai penegakan dibangun.`, 'Ya, tangguhkan')
          if (!ok) return
          await api(`/api/admin/projects/${encodeURIComponent(id)}/suspend`, { method: 'POST' })
          toast(`Proyek "${name}" ditangguhkan.`)
        } else if (btn.dataset.act === 'unsuspend') {
          await api(`/api/admin/projects/${encodeURIComponent(id)}/unsuspend`, { method: 'POST' })
          toast(`Penangguhan proyek "${name}" dibuka.`)
        }
        loadModeration()
      } catch (err) { toast(err.message, 'error') }
    }))
  }

  /* ---------- FITUR 6 — domain kustom ---------- */
  async function loadDomains() {
    const [data, projectsData] = await Promise.all([api('/api/admin/domains'), api('/api/admin/projects')])
    $('#domains-subtitle').textContent = `${fmtNum(data.domains.length)} domain terdaftar · target CNAME ${esc(data.expectedCname)} · SSL: ${esc(data.ssl)}`
    $('#domain-project').innerHTML = projectsData.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`).join('')
    $('#domains-body').innerHTML = data.domains.length
      ? data.domains.map((d) => `<tr>
          <td><strong class="font-monospace">${esc(d.domain)}</strong></td>
          <td>${esc(d.project_name || d.project_id)}<br><small class="text-muted font-monospace">${esc(d.project_id)}</small></td>
          <td>${d.status === 'verified' ? '<span class="badge bg-success">Terverifikasi</span>' : '<span class="badge bg-warning text-dark">Menunggu verifikasi</span>'}</td>
          <td>${esc(fmtDateShort(d.created_at))}</td>
          <td>${d.verified_at ? esc(fmtDateShort(d.verified_at)) : '<span class="text-muted">–</span>'}</td>
          <td class="text-end text-nowrap">
            <button class="btn btn-sm btn-outline-primary" data-act="verify-domain" data-id="${esc(d.id)}" data-domain="${esc(d.domain)}">Periksa DNS</button>
            <button class="btn btn-sm btn-outline-danger" data-act="delete-domain" data-id="${esc(d.id)}" data-domain="${esc(d.domain)}">Hapus</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="text-muted">Belum ada domain.</td></tr>'
    $$('#domains-body [data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const domain = btn.dataset.domain
      try {
        if (btn.dataset.act === 'verify-domain') {
          const box = $('#dns-result')
          box.innerHTML = '<div class="alert alert-info mb-0">Memeriksa DNS ' + esc(domain) + '…</div>'
          const r = await api(`/api/admin/domains/${encodeURIComponent(id)}/verify`, { method: 'POST' })
          box.innerHTML = `<div class="alert ${r.matched ? 'alert-success' : 'alert-warning'} mb-0">
            <strong>${esc(r.domain)}</strong> — ${r.matched ? 'CNAME cocok dengan target platform.' : 'Belum cocok.'}<br>
            <small>CNAME yang ditemukan: ${r.cnames.length ? esc(r.cnames.join(', ')) : (esc(r.cnameError || 'tidak ada'))}<br>
            A yang ditemukan: ${r.addresses.length ? esc(r.addresses.join(', ')) : (esc(r.aError || 'tidak ada'))}<br>
            Target yang diharapkan: CNAME ke <code>${esc(r.expectedCname)}</code><br>
            ${esc(r.note)}<br>SSL: ${esc(r.ssl)}</small></div>`
          loadDomains()
        } else {
          const ok = await confirmDialog('Hapus domain', `Hapus domain ${domain} dari daftar? Routing (bila sudah dipasang manual) tidak ikut dihapus.`, 'Ya, hapus')
          if (!ok) return
          await api(`/api/admin/domains/${encodeURIComponent(id)}`, { method: 'DELETE' })
          toast(`Domain ${domain} dihapus.`)
          loadDomains()
        }
      } catch (err) { toast(err.message, 'error') }
    }))
  }

  const domainAddBtn = $('#domain-add-btn')
  if (domainAddBtn) domainAddBtn.addEventListener('click', async () => {
    const projectId = $('#domain-project').value
    const domain = $('#domain-name').value.trim()
    if (!domain) { toast('Isi dulu nama domainnya.', 'error'); return }
    try {
      await api('/api/admin/domains', { method: 'POST', body: JSON.stringify({ projectId, domain }) })
      toast(`Domain ${domain} ditambahkan.`)
      $('#domain-name').value = ''
      loadDomains()
    } catch (err) { toast(err.message, 'error') }
  })

  async function loadUsage() {
    const data = await api('/api/admin/usage')
    $('#usage-requests').textContent = fmtNum(data.llm.requests)
    $('#usage-prompt').textContent = fmtNum(data.llm.promptTokens)
    $('#usage-completion').textContent = fmtNum(data.llm.completionTokens)
    $('#usage-total').textContent = fmtNum(data.llm.promptTokens + data.llm.completionTokens)
    const labels = data.daily.map((d) => d.date.slice(5))
    makeChart('usageChart', {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Pesan', data: data.daily.map((d) => d.messages), borderColor: chartColors.blue, backgroundColor: 'rgba(37,99,235,.12)', fill: true, tension: 0.3 },
        { label: 'Pengguna baru', data: data.daily.map((d) => d.users), borderColor: chartColors.teal, tension: 0.3 },
        { label: 'Proyek baru', data: data.daily.map((d) => d.projects), borderColor: chartColors.green, tension: 0.3 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
    })
    $('#usage-byuser-body').innerHTML = data.byUser.length
      ? data.byUser.map((u) => `<tr><td>${esc(u.name || u.email)}<br><small class="text-muted">${esc(u.email)}</small></td><td>${fmtNum(u.messages)}</td></tr>`).join('')
      : '<tr><td colspan="2" class="text-muted">Belum ada data.</td></tr>'
    $('#usage-tokens-total').textContent = fmtNum(data.totals.tokens || 0)
    $('#usage-tokens-body').innerHTML = (data.byUserTokens || []).length
      ? data.byUserTokens.map((u) => `<tr><td>${esc(u.name || u.email)}<br><small class="text-muted">${esc(u.email)}</small></td><td>${fmtNum(u.tokens)}</td><td>${fmtNum(u.prompt_tokens)}</td><td>${fmtNum(u.completion_tokens)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="text-muted">Belum ada token tercatat per pengguna.</td></tr>'
  }

  /* ---------- biaya LLM ---------- */
  let costDays = 30
  let costPricesCache = {}
  async function loadCost() {
    const data = await api(`/api/admin/cost?days=${costDays}`)
    costPricesCache = data.prices || {}
    const label = costDays === 0 ? 'semua riwayat' : `${costDays} hari terakhir`
    const csv = $('#cost-csv')
    if (csv) csv.href = `/api/admin/cost.csv?days=${costDays}`
    $('#cost-range-label').textContent = label
    $('#cost-total-tokens').textContent = fmtNum(data.totals.total_tokens)
    $('#cost-requests').textContent = fmtNum(data.totals.requests)
    $('#cost-total-cost').textContent = fmtRp(data.totals.cost_idr)
    $('#cost-alltime-tokens').textContent = fmtNum(data.allTime.total_tokens)
    $('#cost-by-model-body').innerHTML = data.byModel.length
      ? data.byModel.map((m) => `<tr>
          <td class="font-monospace">${esc(m.model || '(tanpa model)')}</td>
          <td>${fmtNum(m.requests)}</td>
          <td>${fmtNum(m.prompt_tokens)}</td>
          <td>${fmtNum(m.completion_tokens)}</td>
          <td>${fmtNum(m.total_tokens)}</td>
          <td>${m.priced ? fmtRp(m.cost_idr) : '<span class="text-muted">–</span>'}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="text-muted">Belum ada token tercatat dalam rentang ini.</td></tr>'
    $('#cost-by-user-body').innerHTML = data.byUser.length
      ? data.byUser.map((u) => `<tr>
          <td>${u.email ? `${esc(u.name || u.email)}<br><small class="text-muted">${esc(u.email)}</small>` : `Pengguna tak dikenal<br><small class="text-muted font-monospace">${esc(u.user_id)}</small>`}</td>
          <td>${fmtNum(u.requests)}</td>
          <td>${fmtNum(u.prompt_tokens)}</td>
          <td>${fmtNum(u.completion_tokens)}</td>
          <td>${fmtNum(u.total_tokens)}</td>
          <td>${u.cost_idr !== null ? fmtRp(u.cost_idr) : '<span class="text-muted">–</span>'}${u.unpriced_tokens > 0 ? `<br><small class="text-muted">${fmtNum(u.unpriced_tokens)} token tanpa harga</small>` : ''}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="text-muted">Belum ada token tercatat dalam rentang ini.</td></tr>'
    const priceModels = Object.keys(costPricesCache).sort()
    const knownModels = data.byModel.map((m) => m.model).filter((m) => m && !priceModels.includes(m))
    $('#cost-prices-body').innerHTML = (priceModels.length || knownModels.length)
      ? priceModels.map((m) => {
          const p = costPricesCache[m]
          return `<tr>
            <td class="font-monospace">${esc(m)}</td>
            <td>Rp ${fmtNum(p.prompt_per_1k)}</td>
            <td>Rp ${fmtNum(p.completion_per_1k)}</td>
            <td class="text-end text-nowrap">
              <button class="btn btn-sm btn-outline-primary" data-act="edit-price" data-model="${esc(m)}">Ubah</button>
              <button class="btn btn-sm btn-outline-danger" data-act="delete-price" data-model="${esc(m)}">Hapus</button>
            </td>
          </tr>`
        }).join('') +
        knownModels.map((m) => `<tr>
          <td class="font-monospace">${esc(m)}</td>
          <td colspan="2"><span class="text-muted">Belum ada harga — biaya tampil “–”.</span></td>
          <td class="text-end text-nowrap"><button class="btn btn-sm btn-outline-primary" data-act="edit-price" data-model="${esc(m)}">Isi harga</button></td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="text-muted">Belum ada harga dan belum ada model tercatat.</td></tr>'
    $$('#cost-prices-body [data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const model = btn.dataset.model
      if (btn.dataset.act === 'delete-price') {
        const ok = await confirmDialog('Hapus harga', `Hapus harga model ${model}? Biayanya kembali tampil “–”.`, 'Ya, hapus')
        if (!ok) return
        try {
          const next = { ...costPricesCache }
          delete next[model]
          await saveCostPrices(next)
        } catch (err) { toast(err.message, 'error') }
        return
      }
      const cur = costPricesCache[model] || { prompt_per_1k: 0, completion_per_1k: 0 }
      const vals = await formDialog(`Harga model ${model}`, [
        { name: 'prompt', label: 'Prompt — Rp per 1.000 token', type: 'number', min: 0, help: 'Tarif prompt sesuai tagihan provider.' },
        { name: 'completion', label: 'Completion — Rp per 1.000 token', type: 'number', min: 0, help: 'Tarif completion sesuai tagihan provider.' },
      ], { prompt: cur.prompt_per_1k, completion: cur.completion_per_1k })
      if (!vals) return
      try {
        const next = { ...costPricesCache, [model]: { prompt_per_1k: Number(vals.prompt) || 0, completion_per_1k: Number(vals.completion) || 0, currency: 'IDR' } }
        await saveCostPrices(next)
      } catch (err) { toast(err.message, 'error') }
    }))
  }

  async function saveCostPrices(prices) {
    await api('/api/admin/cost/prices', { method: 'PUT', body: JSON.stringify({ prices }) })
    toast('Harga model disimpan.')
    loadCost()
  }

  const costDaysSel = $('#cost-days')
  if (costDaysSel) costDaysSel.addEventListener('change', () => {
    costDays = Number(costDaysSel.value) || 0
    loadCost()
  })

  const costAddBtn = $('#cost-add-price-btn')
  if (costAddBtn) costAddBtn.addEventListener('click', async () => {
    const vals = await formDialog('Tambah harga model', [
      { name: 'model', label: 'Nama model', required: true, help: 'cth. cx/gpt-5.6-luna — harus sama persis dengan nama di tabel per model.' },
      { name: 'prompt', label: 'Prompt — Rp per 1.000 token', type: 'number', min: 0, value: 0 },
      { name: 'completion', label: 'Completion — Rp per 1.000 token', type: 'number', min: 0, value: 0 },
    ], {})
    if (!vals || !String(vals.model || '').trim()) return
    try {
      const next = { ...costPricesCache, [String(vals.model).trim()]: { prompt_per_1k: Number(vals.prompt) || 0, completion_per_1k: Number(vals.completion) || 0, currency: 'IDR' } }
      await saveCostPrices(next)
    } catch (err) { toast(err.message, 'error') }
  })

  /* ---------- plan ---------- */
  let plansCache = []
  async function loadPlans() {
    const [plansData, usersData] = await Promise.all([api('/api/admin/plans'), api('/api/admin/users')])
    plansCache = plansData.plans || []
    $('#plans-body').innerHTML = plansCache.length
      ? plansCache.map((p) => `<tr>
          <td><strong>${esc(p.name)}</strong><br><small class="text-muted font-monospace">${esc(p.id)}</small></td>
          <td>${p.token_limit > 0 ? fmtNum(p.token_limit) : '<span class="badge bg-success">Tanpa batas</span>'}</td>
          <td>Rp ${fmtNum(p.price_idr)}</td>
          <td>${fmtNum(p.users)}</td>
          <td>${esc(p.description || '–')}</td>
          <td class="text-end text-nowrap">
            <button class="btn btn-sm btn-outline-primary" data-act="edit-plan" data-id="${esc(p.id)}">Ubah</button>
            <button class="btn btn-sm btn-outline-danger" data-act="delete-plan" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Hapus</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="text-muted">Belum ada plan.</td></tr>'

    const planOptions = (currentId) => `<option value="">— Tanpa plan —</option>` + plansCache.map((p) => `<option value="${esc(p.id)}"${p.id === currentId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')
    $('#plan-users-body').innerHTML = usersData.users.map((u) => {
      const pct = u.plan_limit > 0 ? Math.min(100, Math.round((u.tokens / u.plan_limit) * 100)) : null
      const quota = u.plan_limit > 0
        ? `<div class="progress" style="height: 6px;"><div class="progress-bar ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-success'}" style="width: ${pct}%"></div></div><small class="text-muted">${fmtNum(u.tokens)} / ${fmtNum(u.plan_limit)} (${pct}%)</small>`
        : `<small class="text-muted">${fmtNum(u.tokens)} dipakai · tanpa batas</small>`
      return `<tr>
        <td>${esc(u.name || u.email)}<br><small class="text-muted">${esc(u.email)}</small></td>
        <td>${u.plan_name ? `<span class="badge bg-info">${esc(u.plan_name)}</span>` : '<span class="text-muted">–</span>'}</td>
        <td>${fmtNum(u.tokens)}</td>
        <td>${quota}</td>
        <td><select class="form-select form-select-sm" data-plan-user="${esc(u.id)}" style="max-width: 200px;">${planOptions(u.plan_id)}</select></td>
      </tr>`
    }).join('')

    $$('#plans-body [data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      if (btn.dataset.act === 'delete-plan') {
        const ok = await confirmDialog('Hapus plan', `Hapus plan "${btn.dataset.name}"? Pengguna yang memakai plan ini jadi tanpa plan.`, 'Ya, hapus')
        if (!ok) return
        try {
          await api(`/api/admin/plans/${encodeURIComponent(id)}`, { method: 'DELETE' })
          toast('Plan dihapus.')
          loadPlans()
        } catch (err) { toast(err.message, 'error') }
        return
      }
      const p = plansCache.find((x) => x.id === id)
      if (!p) return
      const vals = await formDialog('Ubah plan', [
        { name: 'name', label: 'Nama plan', required: true },
        { name: 'tokenLimit', label: 'Kuota token (0 = tanpa batas)', type: 'number', min: 0, help: 'Jumlah token maksimum per pengguna.' },
        { name: 'priceIdr', label: 'Harga (Rp)', type: 'number', min: 0 },
        { name: 'description', label: 'Keterangan', type: 'textarea' },
      ], { name: p.name, tokenLimit: p.token_limit, priceIdr: p.price_idr, description: p.description })
      if (!vals) return
      try {
        await api(`/api/admin/plans/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: vals.name, tokenLimit: vals.tokenLimit, priceIdr: vals.priceIdr, description: vals.description }) })
        toast('Plan diperbarui.')
        loadPlans()
      } catch (err) { toast(err.message, 'error') }
    }))

    $$('#plan-users-body [data-plan-user]').forEach((sel) => sel.addEventListener('change', async () => {
      const userId = sel.dataset.planUser
      const planId = sel.value || null
      try {
        await api(`/api/admin/users/${encodeURIComponent(userId)}/plan`, { method: 'POST', body: JSON.stringify({ planId }) })
        toast('Plan pengguna diperbarui.')
        loadPlans()
      } catch (err) {
        toast(err.message, 'error')
        loadPlans()
      }
    }))
  }

  const planAddBtn = $('#plan-add-btn')
  if (planAddBtn) planAddBtn.addEventListener('click', async () => {
    const vals = await formDialog('Tambah plan', [
      { name: 'name', label: 'Nama plan', required: true, help: 'cth. Pro, Starter, Enterprise' },
      { name: 'tokenLimit', label: 'Kuota token (0 = tanpa batas)', type: 'number', min: 0, value: 0 },
      { name: 'priceIdr', label: 'Harga (Rp)', type: 'number', min: 0, value: 0 },
      { name: 'description', label: 'Keterangan', type: 'textarea' },
    ], {})
    if (!vals || !String(vals.name || '').trim()) return
    try {
      await api('/api/admin/plans', { method: 'POST', body: JSON.stringify({ name: vals.name, tokenLimit: vals.tokenLimit, priceIdr: vals.priceIdr, description: vals.description }) })
      toast('Plan dibuat.')
      loadPlans()
    } catch (err) { toast(err.message, 'error') }
  })

  /* ---------- kelola credit (fase 4) ---------- */
  let creditUserId = null
  async function loadCreditSettings() {
    const s = await api('/api/admin/credits/settings')
    $('#credit-set-grant').value = s.settings.freeGrant
    $('#credit-set-days').value = s.settings.freeDays
    $('#credit-set-cap').value = s.settings.freeDailyCap
    $('#credit-set-min').value = s.settings.minBalance
  }
  async function searchCreditUsers() {
    const q = $('#credit-search').value.trim()
    const data = await api(`/api/admin/credits/users?q=${encodeURIComponent(q)}`)
    $('#credit-users-body').innerHTML = data.users.length
      ? data.users.map((u) => `<tr>
          <td>${esc(u.name || u.email)}<br><small class="text-muted">${esc(u.email)}</small></td>
          <td>${esc(u.plan_name)}</td>
          <td>${fmtNum(u.free_balance)}</td>
          <td>${fmtNum(u.purchased_balance)}</td>
          <td>${fmtNum(u.plan_credits)}</td>
          <td><strong>${fmtNum(u.total)}</strong></td>
          <td class="text-end"><button class="btn btn-sm btn-outline-primary" data-credit-user="${esc(u.id)}">Lihat</button></td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="text-muted">Tidak ada pengguna yang cocok.</td></tr>'
    $$('#credit-users-body [data-credit-user]').forEach((btn) => btn.addEventListener('click', () => loadCreditDetail(btn.dataset.creditUser)))
  }
  async function loadCreditDetail(userId) {
    creditUserId = userId
    const d = await api(`/api/admin/credits/users/${encodeURIComponent(userId)}`)
    $('#credit-detail').hidden = false
    $('#credit-detail-title').textContent = `${d.user.name || d.user.email} (${d.user.email})`
    $('#credit-detail-plan').textContent = `${d.plan.planName} · ${fmtNum(d.plan.monthlyCredits)} credit/bln`
    const b = d.balance
    $('#credit-bal-free').textContent = fmtNum(b.free)
    $('#credit-bal-purchased').textContent = fmtNum(b.purchased)
    $('#credit-bal-plan').textContent = fmtNum(b.plan)
    $('#credit-bal-total').textContent = fmtNum(b.total)
    $('#credit-exp-free').textContent = b.freeExpiresAt ? `berlaku s.d. ${fmtDateShort(b.freeExpiresAt)}` : 'tanpa kedaluwarsa'
    $('#credit-exp-purchased').textContent = b.purchasedExpiresAt ? `berlaku s.d. ${fmtDateShort(b.purchasedExpiresAt)}` : 'tanpa kedaluwarsa'
    $('#credit-exp-plan').textContent = b.planExpiresAt ? `jatah s.d. ${fmtDateShort(b.planExpiresAt)}` : 'tanpa jatah'
    $('#credit-reset').textContent = d.raw && d.raw.plan_credits_reset_at ? `reset jatah: ${fmtDateShort(d.raw.plan_credits_reset_at)}` : '–'
    $('#credit-usage-body').innerHTML = d.usage.length
      ? d.usage.map((u) => `<tr><td>${fmtDate(u.created_at)}</td><td>${esc(u.model)}</td><td class="text-end">${fmtNum(u.credit)}</td><td class="text-end">${u.shortfall_credit ? fmtNum(u.shortfall_credit) : '–'}</td></tr>`).join('')
      : '<tr><td colspan="4" class="text-muted">Belum ada pemakaian.</td></tr>'
    $('#credit-orders-body').innerHTML = d.orders.length
      ? d.orders.map((o) => `<tr><td class="font-monospace">${esc(o.order_id)}</td><td class="text-end">${fmtRp(o.amount_idr)}</td><td class="text-end">${fmtNum(o.credits)}</td><td>${esc(o.status)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="text-muted">Belum ada top-up.</td></tr>'
    $('#credit-tx-body').innerHTML = d.transactions.length
      ? d.transactions.map((t) => `<tr><td>${fmtDate(t.created_at)}</td><td>${esc(t.kind)}</td><td>${esc(t.bucket || '–')}</td><td class="text-end">${t.amount > 0 ? '+' : ''}${fmtNum(t.amount)}</td><td class="text-end">${fmtNum(t.balance_after)}</td><td>${esc(t.reason || '')}</td></tr>`).join('')
      : '<tr><td colspan="6" class="text-muted">Belum ada transaksi.</td></tr>'
    document.getElementById('credit-detail').scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  async function loadCredits() {
    await loadCreditSettings()
    const searchBtn = $('#credit-search-btn')
    if (searchBtn && !searchBtn.dataset.wired) {
      searchBtn.dataset.wired = '1'
      searchBtn.addEventListener('click', async () => {
        try { await searchCreditUsers() } catch (err) { toast(err.message, 'error') }
      })
      $('#credit-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); searchBtn.click() }
      })
      $('#credit-adjust-form').addEventListener('submit', async (e) => {
        e.preventDefault()
        if (!creditUserId) return
        const amount = Number($('#credit-adjust-amount').value)
        const reason = $('#credit-adjust-reason').value.trim()
        if (!amount || !reason) { toast('Isi jumlah dan alasan.', 'error'); return }
        try {
          const res = await api(`/api/admin/credits/users/${encodeURIComponent(creditUserId)}/adjust`, {
            method: 'POST',
            body: JSON.stringify({ bucket: $('#credit-adjust-bucket').value, amount, reason }),
          })
          toast(`Penyesuaian diterapkan. Saldo sekarang ${fmtNum(res.balance.total)} credit.`)
          $('#credit-adjust-amount').value = ''
          $('#credit-adjust-reason').value = ''
          await loadCreditDetail(creditUserId)
        } catch (err) { toast(err.message, 'error') }
      })
      $('#credit-settings-form').addEventListener('submit', async (e) => {
        e.preventDefault()
        try {
          await api('/api/admin/credits/settings', {
            method: 'PUT',
            body: JSON.stringify({
              freeGrant: Number($('#credit-set-grant').value),
              freeDays: Number($('#credit-set-days').value),
              freeDailyCap: Number($('#credit-set-cap').value),
              minBalance: Number($('#credit-set-min').value),
            }),
          })
          toast('Pengaturan credit disimpan.')
          await loadCreditSettings()
        } catch (err) { toast(err.message, 'error') }
      })
    }
  }

  /* ---------- pengaturan AI ---------- */
  function srcBadge(src) {
    if (src === 'db') return '<span class="badge bg-primary">panel</span>'
    if (src === 'env') return '<span class="badge bg-warning text-dark">env</span>'
    return '<span class="badge bg-secondary">default</span>'
  }
  async function loadAiSettings() {
    const s = await api('/api/admin/ai-settings')
    $('#ai-model').value = s.model || ''
    $('#ai-model').placeholder = s.defaults.model
    $('#ai-model-strong').value = s.modelStrong || ''
    $('#ai-model-strong').placeholder = s.defaults.modelStrong
    $('#ai-model-audit').value = s.modelAudit || ''
    $('#ai-model-audit').placeholder = s.defaults.modelAudit
    $('#ai-endpoint').value = s.endpoint || ''
    $('#ai-key').value = ''
    $('#ai-key').placeholder = s.keyConfigured ? '•••••••• (terpasang — isi untuk mengganti)' : 'Belum ada key'
    $('#ai-model-src').innerHTML = srcBadge(s.sources.model)
    $('#ai-model-strong-src').innerHTML = srcBadge(s.sources.modelStrong)
    $('#ai-model-audit-src').innerHTML = srcBadge(s.sources.modelAudit)
    $('#ai-endpoint-src').innerHTML = srcBadge(s.sources.endpoint)
    $('#ai-key-src').innerHTML = srcBadge(s.sources.key)
    $('#ai-effective-list').innerHTML = [
      ['Model utama', s.model],
      ['Model kuat', s.modelStrong],
      ['Model audit', s.modelAudit],
      ['Endpoint', s.endpoint],
      ['API key', s.keyConfigured ? 'Terpasang' : 'Tidak ada'],
    ].map(([k, v]) => `<dt class="col-sm-4">${esc(k)}</dt><dd class="col-sm-8 font-monospace">${esc(v)}</dd>`).join('')
  }

  const aiForm = $('#ai-settings-form')
  if (aiForm) aiForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const payload = {
      model: $('#ai-model').value.trim(),
      modelStrong: $('#ai-model-strong').value.trim(),
      modelAudit: $('#ai-model-audit').value.trim(),
      endpoint: $('#ai-endpoint').value.trim(),
    }
    const key = $('#ai-key').value.trim()
    if (key) payload.key = key
    try {
      await api('/api/admin/ai-settings', { method: 'PUT', body: JSON.stringify(payload) })
      toast('Pengaturan AI disimpan — berlaku langsung tanpa restart.')
      $('#ai-key').value = ''
      loadAiSettings()
    } catch (err) { toast(err.message, 'error') }
  })

  const aiTestBtn = $('#ai-test-btn')
  if (aiTestBtn) aiTestBtn.addEventListener('click', async () => {
    const box = $('#ai-test-result')
    box.innerHTML = '<p class="text-muted mb-0"><span class="spinner-border spinner-border-sm me-2"></span>Mengirim prompt tes ke LLM…</p>'
    try {
      const r = await api('/api/admin/ai-settings/test', { method: 'POST' })
      box.innerHTML = `<p class="mb-1"><span class="badge bg-success">Berhasil</span> <small class="text-muted">${r.latencyMs} ms · model <code>${esc(r.model)}</code></small></p><p class="mb-0">Balasan: <strong>${esc(r.reply)}</strong></p>`
    } catch (err) {
      box.innerHTML = `<p class="mb-1"><span class="badge bg-danger">Gagal</span></p><p class="text-danger mb-0">${esc(err.message)}</p>`
    }
  })

  /* ---------- build ---------- */
  async function loadBuilds() {
    const data = await api('/api/admin/builds?limit=100')
    $('#builds-subtitle').textContent = `${fmtNum(data.builds.length)} build terakhir dari semua proyek`
    $('#builds-body').innerHTML = data.builds.length
      ? data.builds.map((b) => `<tr>
          <td class="font-monospace">${b.id}</td>
          <td><strong>${esc(b.project_name)}</strong><br><small class="text-muted font-monospace">${esc(b.project_id)}</small></td>
          <td>${esc(b.owner_email || '–')}</td>
          <td>${b.ok ? '<span class="badge bg-success">Berhasil</span>' : '<span class="badge bg-danger">Gagal</span>'}</td>
          <td>${esc(fmtDate(b.created_at))}</td>
          <td class="text-end"><button class="btn btn-sm btn-outline-secondary" data-act="show-log" data-id="${esc(b.id)}" data-log="${esc(b.log || '')}" data-name="${esc(b.project_name)}">Lihat log</button></td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="text-muted">Belum ada build.</td></tr>'
    $$('#builds-body [data-act="show-log"]').forEach((btn) => btn.addEventListener('click', () => {
      $('#log-title').textContent = `Log build #${btn.dataset.id} — ${btn.dataset.name}`
      $('#log-body').textContent = btn.dataset.log || '(log kosong)'
      new bootstrap.Modal($('#logModal')).show()
    }))
  }

  /* ---------- pesan ---------- */
  let messagesQuery = ''
  async function loadMessages() {
    const q = messagesQuery ? `?q=${encodeURIComponent(messagesQuery)}&limit=100` : '?limit=100'
    const data = await api(`/api/admin/messages${q}`)
    $('#messages-body').innerHTML = data.messages.length
      ? data.messages.map((m) => `<tr>
          <td><strong>${esc(m.project_name)}</strong><br><small class="text-muted font-monospace">${esc(m.project_id)}</small></td>
          <td>${esc(m.owner_email || '–')}</td>
          <td><span class="badge ${m.role === 'user' ? 'bg-primary' : m.role === 'assistant' ? 'bg-success' : 'bg-secondary'}">${esc(m.role)}</span></td>
          <td class="text-break" style="min-width: 300px">${esc(m.excerpt)}</td>
          <td>${esc(fmtDate(m.created_at))}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="text-muted">Tidak ada pesan.</td></tr>'
  }

  function runMessagesSearch() {
    messagesQuery = $('#messages-search').value.trim()
    loadMessages()
  }
  const msgSearchBtn = $('#messages-search-btn')
  if (msgSearchBtn) msgSearchBtn.addEventListener('click', runMessagesSearch)
  const msgSearch = $('#messages-search')
  if (msgSearch) msgSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runMessagesSearch() } })

  /* ---------- pengumuman (fitur 4) ---------- */
  let announcementsCache = []
  async function loadAnnouncements() {
    const data = await api('/api/admin/announcements')
    announcementsCache = data.announcements || []
    const body = $('#announcements-body')
    if (!body) return
    body.innerHTML = announcementsCache.length
      ? announcementsCache.map((a) => {
          const excerpt = a.body.length > 120 ? `${a.body.slice(0, 120)}…` : a.body
          return `<tr>
            <td><strong>${esc(a.title)}</strong></td>
            <td class="text-break" style="min-width: 240px">${esc(excerpt || '–')}</td>
            <td>${a.active ? '<span class="badge bg-success">Aktif</span>' : '<span class="badge bg-secondary">Nonaktif</span>'}</td>
            <td>${esc(fmtDate(a.created_at))}</td>
            <td class="text-end text-nowrap">
              ${a.active
                ? `<button class="btn btn-sm btn-outline-warning" data-act="deactivate-announcement" data-id="${a.id}">Nonaktifkan</button>`
                : `<button class="btn btn-sm btn-outline-success" data-act="activate-announcement" data-id="${a.id}">Aktifkan</button>`}
              <button class="btn btn-sm btn-outline-primary" data-act="edit-announcement" data-id="${a.id}">Ubah</button>
              <button class="btn btn-sm btn-outline-danger" data-act="delete-announcement" data-id="${a.id}" data-title="${esc(a.title)}">Hapus</button>
            </td>
          </tr>`
        }).join('')
      : '<tr><td colspan="5" class="text-muted">Belum ada pengumuman.</td></tr>'
    $$('#announcements-body [data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      if (btn.dataset.act === 'activate-announcement') {
        const ok = await confirmDialog('Aktifkan pengumuman', 'Aktifkan pengumuman ini? Pengumuman aktif lainnya akan dinonaktifkan.', 'Ya, aktifkan')
        if (!ok) return
        try {
          await api(`/api/admin/announcements/${encodeURIComponent(id)}/activate`, { method: 'POST' })
          toast('Pengumuman diaktifkan.')
          loadAnnouncements()
        } catch (err) { toast(err.message, 'error') }
      } else if (btn.dataset.act === 'deactivate-announcement') {
        try {
          await api(`/api/admin/announcements/${encodeURIComponent(id)}/activate`, { method: 'POST', body: JSON.stringify({ active: false }) })
          toast('Pengumuman dinonaktifkan.')
          loadAnnouncements()
        } catch (err) { toast(err.message, 'error') }
      } else if (btn.dataset.act === 'delete-announcement') {
        const ok = await confirmDialog('Hapus pengumuman', `Hapus pengumuman "${btn.dataset.title}"? Tindakan ini tidak bisa dibatalkan.`, 'Ya, hapus')
        if (!ok) return
        try {
          await api(`/api/admin/announcements/${encodeURIComponent(id)}`, { method: 'DELETE' })
          toast('Pengumuman dihapus.')
          loadAnnouncements()
        } catch (err) { toast(err.message, 'error') }
      } else if (btn.dataset.act === 'edit-announcement') {
        const a = announcementsCache.find((x) => String(x.id) === String(id))
        if (!a) return
        const vals = await formDialog('Ubah pengumuman', [
          { name: 'title', label: 'Judul', required: true },
          { name: 'body', label: 'Isi', type: 'textarea', rows: 4 },
        ], { title: a.title, body: a.body })
        if (!vals || !String(vals.title || '').trim()) return
        try {
          await api(`/api/admin/announcements/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ title: vals.title, body: vals.body }) })
          toast('Pengumuman diperbarui.')
          loadAnnouncements()
        } catch (err) { toast(err.message, 'error') }
      }
    }))
  }

  const announcementAddBtn = $('#announcement-add-btn')
  if (announcementAddBtn) announcementAddBtn.addEventListener('click', async () => {
    const vals = await formDialog('Buat pengumuman', [
      { name: 'title', label: 'Judul', required: true },
      { name: 'body', label: 'Isi', type: 'textarea', rows: 4, help: 'Isi pengumuman yang ditampilkan di banner builder.' },
    ], {})
    if (!vals || !String(vals.title || '').trim()) return
    try {
      await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify({ title: vals.title, body: vals.body }) })
      toast('Pengumuman dibuat (belum aktif).')
      loadAnnouncements()
    } catch (err) { toast(err.message, 'error') }
  })

  /* ---------- pemeliharaan (fitur 8) ---------- */
  function updateMaintenancePreview() {
    const text = $('#maintenance-preview-text')
    if (!text) return
    const msg = $('#maintenance-message').value.trim()
    text.textContent = msg || 'Belum ada pesan.'
  }

  async function loadMaintenance() {
    const s = await api('/api/admin/maintenance')
    const enabled = $('#maintenance-enabled')
    if (!enabled) return
    enabled.checked = !!s.enabled
    $('#maintenance-message').value = s.message || ''
    updateMaintenancePreview()
    $('#maintenance-updated').textContent = s.updated_at ? `Terakhir disimpan ${fmtDate(s.updated_at)}` : ''
    $('#maintenance-status-body').innerHTML = s.enabled
      ? '<p class="mb-1"><span class="badge bg-warning text-dark">Mode pemeliharaan AKTIF</span></p><p class="text-muted mb-0">Pengaturan tersimpan, tapi halaman maintenance untuk pengunjung belum tampil — middleware penyajian belum dipasang.</p>'
      : '<p class="mb-1"><span class="badge bg-success">Mode pemeliharaan nonaktif</span></p><p class="text-muted mb-0">Situs berjalan normal.</p>'
  }

  const maintenanceMessage = $('#maintenance-message')
  if (maintenanceMessage) maintenanceMessage.addEventListener('input', updateMaintenancePreview)

  const maintenanceForm = $('#maintenance-form')
  if (maintenanceForm) maintenanceForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const enabled = $('#maintenance-enabled').checked
    const message = $('#maintenance-message').value
    try {
      await api('/api/admin/maintenance', { method: 'PUT', body: JSON.stringify({ enabled, message }) })
      toast(enabled ? 'Mode pemeliharaan diaktifkan (tersimpan; halaman pengunjung menyusul).' : 'Mode pemeliharaan dimatikan.')
      loadMaintenance()
    } catch (err) { toast(err.message, 'error') }
  })

  /* ---------- log audit (FITUR 1) ---------- */
  let auditQuery = ''
  let auditAction = ''
  let auditActionsCache = []
  async function loadAudit() {
    const params = new URLSearchParams({ limit: '100' })
    if (auditQuery) params.set('q', auditQuery)
    if (auditAction) params.set('action', auditAction)
    const data = await api(`/api/admin/audit?${params.toString()}`)
    const logs = data.logs || []
    $('#audit-subtitle').textContent = `${fmtNum(logs.length)} entri log`
    /* Daftar aksi di-cache dari muatan tanpa filter, supaya dropdown tidak
       menyusut jadi satu opsi saat sedang memfilter per aksi. */
    const actions = [...new Set(logs.map((l) => l.action))].sort()
    if (!auditAction && actions.length) auditActionsCache = actions
    const options = auditActionsCache.length ? auditActionsCache : actions
    const filter = $('#audit-action-filter')
    if (filter) {
      filter.innerHTML = '<option value="">Semua aksi</option>' + options.map((a) => `<option value="${esc(a)}"${a === auditAction ? ' selected' : ''}>${esc(a)}</option>`).join('')
    }
    $('#audit-body').innerHTML = logs.length
      ? logs.map((l) => `<tr>
          <td class="text-nowrap">${esc(fmtDate(l.created_at))}</td>
          <td>${esc(l.admin_email || '–')}</td>
          <td><span class="badge bg-secondary">${esc(l.action)}</span></td>
          <td>${esc(l.target_type)}${l.target_id ? `<br><small class="text-muted font-monospace">${esc(l.target_id)}</small>` : ''}</td>
          <td class="text-break" style="min-width: 220px">${esc(l.detail || '–')}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="text-muted">Tidak ada log yang cocok.</td></tr>'
  }

  function runAuditSearch() {
    auditQuery = $('#audit-search').value.trim()
    auditAction = $('#audit-action-filter').value
    loadAudit()
  }
  const auditSearchBtn = $('#audit-search-btn')
  if (auditSearchBtn) auditSearchBtn.addEventListener('click', runAuditSearch)
  const auditSearch = $('#audit-search')
  if (auditSearch) auditSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runAuditSearch() } })
  const auditFilter = $('#audit-action-filter')
  if (auditFilter) auditFilter.addEventListener('change', runAuditSearch)
  /* ---------- sesi ---------- */
  async function loadSessions() {
    const data = await api('/api/admin/sessions')
    $('#sessions-body').innerHTML = data.sessions.length
      ? data.sessions.map((s) => `<tr>
          <td>${esc(s.name || s.email || '–')}<br><small class="text-muted">${esc(s.email || '')}</small></td>
          <td>${esc(fmtDate(s.created_at))}</td>
          <td>${esc(fmtDate(s.expires_at))}</td>
          <td>${s.active ? '<span class="badge bg-success">Aktif</span>' : '<span class="badge bg-secondary">Kedaluwarsa</span>'}</td>
          <td class="font-monospace">${esc(s.hash)}</td>
          <td class="text-end">${s.active ? `<button class="btn btn-sm btn-outline-danger" data-act="revoke-session" data-hash="${esc(s.hash)}" data-email="${esc(s.email || '')}">Cabut</button>` : '<span class="text-muted small">–</span>'}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="text-muted">Tidak ada sesi.</td></tr>'
    $$('#sessions-body [data-act="revoke-session"]').forEach((btn) => btn.addEventListener('click', async () => {
      const ok = await confirmDialog('Cabut sesi', `Cabut sesi login milik ${btn.dataset.email}? Pengguna harus masuk lagi.`, 'Ya, cabut')
      if (!ok) return
      try {
        await api(`/api/admin/sessions/${encodeURIComponent(btn.dataset.hash)}`, { method: 'DELETE' })
        toast('Sesi dicabut.')
        loadSessions()
      } catch (err) { toast(err.message, 'error') }
    }))
  }

  async function loadHealth() {
    const h = await api('/api/admin/health')
    const upH = Math.floor(h.uptimeSec / 3600)
    const upM = Math.floor((h.uptimeSec % 3600) / 60)
    const cards = [
      { icon: 'bi-activity', color: 'primary', label: 'Uptime server', value: `${upH} jam ${upM} mnt`, sub: `Node ${esc(h.node)} · ${esc(h.platform)}` },
      { icon: 'bi-memory', color: 'info', label: 'Memori (RSS)', value: fmtBytes(h.memory.rss), sub: `Heap ${fmtBytes(h.memory.heapUsed)} / ${fmtBytes(h.memory.heapTotal)}` },
      { icon: 'bi-database', color: 'success', label: 'Ukuran database', value: fmtBytes(h.dbSize), sub: `${fmtNum(h.counts.users)} pengguna · ${fmtNum(h.counts.projects)} proyek` },
      { icon: 'bi-chat-dots', color: 'warning', label: 'Sesi aktif', value: fmtNum(h.counts.sessions), sub: `${fmtNum(h.counts.messages)} pesan · ${fmtNum(h.counts.builds)} build` },
    ]
    $('#health-cards').innerHTML = cards.map((c) => `<div class="col-sm-6 col-xl-3"><div class="card stats-card"><div class="card-body"><div class="d-flex align-items-center">
      <div class="flex-shrink-0"><div class="stats-icon bg-${c.color} bg-opacity-10 text-${c.color}"><i class="bi ${c.icon}"></i></div></div>
      <div class="flex-grow-1 ms-3"><p class="h6 mb-0 text-muted">${c.label}</p><div class="h5 mb-0">${c.value}</div><small class="text-muted">${c.sub}</small></div>
    </div></div></div>`).join('')

    const llm = h.llm
    $('#llm-status-body').innerHTML = `
      <dl class="row mb-0">
        <dt class="col-sm-4">Endpoint</dt><dd class="col-sm-8 font-monospace">${esc(llm.host)}</dd>
        <dt class="col-sm-4">Model</dt><dd class="col-sm-8 font-monospace">${esc(h.model)}</dd>
        <dt class="col-sm-4">API key</dt><dd class="col-sm-8">${llm.keyConfigured ? '<span class="badge bg-success">Terpasang</span>' : '<span class="badge bg-danger">Tidak ada</span>'}</dd>
        <dt class="col-sm-4">Status</dt><dd class="col-sm-8">${llm.reachable
          ? `<span class="badge bg-success">Terjangkau${llm.status ? ` (HTTP ${llm.status})` : ''}</span> <small class="text-muted">${llm.latencyMs} ms</small>`
          : `<span class="badge bg-danger">Tidak terjangkau</span><br><small class="text-danger">${esc(llm.error || '')}</small>`}</dd>
      </dl>`

    const previews = h.previews || {}
    const entries = Object.entries(previews)
    $('#previews-body').innerHTML = entries.length
      ? `<div class="table-responsive"><table class="table table-hover mb-0"><thead class="table-light"><tr><th>Proyek</th><th>Port</th></tr></thead><tbody>${entries.map(([id, port]) => `<tr><td class="font-monospace">${esc(id)}</td><td>${esc(port)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="text-muted mb-0">Tidak ada preview yang berjalan saat ini.</p>'

    /* Ambang peringatan (FITUR 10): tampil sebagai teks di halaman ini. */
    try {
      const alertsData = await api('/api/admin/alerts')
      const th = alertsData.thresholds || {}
      const box = $('#alert-thresholds-body')
      if (box) {
        const active = alertsData.alerts || []
        box.innerHTML = `<dl class="row mb-0">
          <dt class="col-sm-6">Build gagal (1 jam)</dt><dd class="col-sm-6">${esc(th.buildFailCount ?? 3)} gagal atau &gt;${esc(th.buildFailPct ?? 50)}% gagal</dd>
          <dt class="col-sm-6">Disk penuh</dt><dd class="col-sm-6">&gt;${esc(th.diskPct ?? 85)}% terpakai</dd>
          <dt class="col-sm-6">Peringatan aktif</dt><dd class="col-sm-6">${active.length ? active.map((a) => `<span class="badge ${a.level === 'critical' ? 'bg-danger' : 'bg-warning text-dark'} me-1">${esc(a.kind)}</span>`).join('') : '<span class="badge bg-success">Tidak ada</span>'}</dd>
        </dl><p class="text-muted small mb-0 mt-2">Ambang tersimpan di pengaturan admin (key alert_thresholds).</p>`
      }
    } catch { /* ambang gagal dimuat — kartu kesehatan lain tetap tampil */ }

    const badge = $('#nav-health-badge')
    if (badge) {
      if (llm.reachable) { badge.className = 'badge rounded-pill ms-auto bg-success'; badge.textContent = 'OK' }
      else { badge.className = 'badge rounded-pill ms-auto bg-danger'; badge.textContent = 'LLM mati' }
    }
  }

  async function loadSettings() {
    const s = await api('/api/admin/settings')
    const rows = [
      ['Model utama', s.model],
      ['Model kuat', s.modelStrong],
      ['Model audit', s.modelAudit],
      ['LLM host', s.llmHost],
      ['API key LLM', s.keyConfigured ? 'Terpasang' : 'Tidak ada'],
      ['Domain publik', `${s.publicSuffix} (${s.publicOrigin})`],
      ['Database', `${s.dbPath} (${fmtBytes(s.dbSize)})`],
      ['Pendaftaran', s.signupOpen ? 'Terbuka (belum ada pengguna)' : 'Tertutup (sudah ada pengguna)'],
    ]
    $('#settings-list').innerHTML = rows.map(([k, v]) => `<dt class="col-sm-4">${esc(k)}</dt><dd class="col-sm-8 font-monospace">${esc(v)}</dd>`).join('')
    $('#admin-identity-body').innerHTML = s.admin
      ? `<p class="mb-1"><strong>${esc(s.admin.email)}</strong></p>
         <p class="text-muted mb-0">Ditentukan lewat ${s.admin.via === 'env' ? 'environment <code>VB_ADMIN_EMAIL</code>' : 'akun pertama yang dibuat (pemilik instalasi)'}.</p>`
      : '<p class="text-muted mb-0">Belum ada pengguna, jadi belum ada admin.</p>'
  }

  /* ---------- cadangan & pulihkan ---------- */
  async function loadBackup() {
    const data = await api('/api/admin/backup/list')
    const cards = [
      { icon: 'bi-database', color: 'primary', label: 'Ukuran database', value: fmtBytes(data.dbSize), sub: 'file vibebuilder.db aktif' },
      { icon: 'bi-people', color: 'success', label: 'Pengguna', value: fmtNum(data.counts.users), sub: `${fmtNum(data.counts.projects)} proyek` },
      { icon: 'bi-chat-dots', color: 'info', label: 'Pesan', value: fmtNum(data.counts.messages), sub: `${fmtNum(data.counts.builds)} build tercatat` },
      { icon: 'bi-archive', color: 'warning', label: 'File cadangan', value: fmtNum(data.files.length), sub: 'di direktori data server' },
    ]
    $('#backup-cards').innerHTML = cards.map((c) => `<div class="col-sm-6 col-xl-3"><div class="card stats-card"><div class="card-body"><div class="d-flex align-items-center">
      <div class="flex-shrink-0"><div class="stats-icon bg-${c.color} bg-opacity-10 text-${c.color}"><i class="bi ${c.icon}"></i></div></div>
      <div class="flex-grow-1 ms-3"><p class="h6 mb-0 text-muted">${c.label}</p><div class="h5 mb-0">${c.value}</div><small class="text-muted">${c.sub}</small></div>
    </div></div></div>`).join('')
    $('#backup-files-body').innerHTML = data.files.length
      ? data.files.map((f) => `<tr>
          <td class="font-monospace text-break">${esc(f.name)}${f.isAutoBackup ? ' <span class="badge bg-secondary">otomatis</span>' : ''}</td>
          <td>${fmtBytes(f.size)}</td>
          <td>${esc(fmtDate(f.mtime))}</td>
          <td class="text-end text-nowrap">
            ${f.isAutoBackup ? `<button class="btn btn-sm btn-outline-warning" data-act="restore-backup" data-name="${esc(f.name)}">Pulihkan</button>` : '<span class="text-muted small">–</span>'}
          </td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="text-muted">Belum ada file cadangan. Unduh cadangan dulu, atau pulihkan sekali — cadangan otomatis akan muncul di sini.</td></tr>'
    $$('#backup-files-body [data-act="restore-backup"]').forEach((btn) => btn.addEventListener('click', async () => {
      const ok = await confirmDialog('Pulihkan dari cadangan otomatis', `Ganti database aktif dengan ${btn.dataset.name}? Database aktif saat ini disimpan dulu sebagai cadangan otomatis baru, lalu server restart sendiri.`, 'Ya, pulihkan')
      if (!ok) return
      try {
        await api('/api/admin/restore', { method: 'POST', body: JSON.stringify({ backup: btn.dataset.name }) })
        $('#restore-result').innerHTML = '<p class="mb-0"><span class="badge bg-success">Berhasil</span> Server sedang restart dengan database yang dipulihkan. Tunggu beberapa detik lalu muat ulang halaman ini.</p>'
        toast('Pemulihan diterima — server sedang restart.')
      } catch (err) { toast(err.message, 'error') }
    }))
  }

  const restoreForm = $('#restore-form')
  if (restoreForm) restoreForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = $('#restore-file')
    if (!input.files || !input.files[0]) { toast('Pilih dulu file cadangan (.db).', 'error'); return }
    const ok = await confirmDialog('Pulihkan database', 'Ganti database aktif dengan file yang diunggah? Database aktif saat ini disimpan dulu sebagai cadangan otomatis baru, lalu server restart sendiri.', 'Ya, pulihkan')
    if (!ok) return
    const box = $('#restore-result')
    const btn = $('#restore-submit')
    btn.disabled = true
    box.innerHTML = '<p class="text-muted mb-0"><span class="spinner-border spinner-border-sm me-2"></span>Memvalidasi dan memulihkan…</p>'
    try {
      const form = new FormData()
      form.append('file', input.files[0])
      const res = await fetch('/api/admin/restore', { method: 'POST', body: form })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error((data && data.error) || `Pemulihan gagal (${res.status}).`)
      box.innerHTML = `<p class="mb-0"><span class="badge bg-success">Berhasil</span> Server sedang restart dengan database yang dipulihkan. Cadangan otomatis: <code>${esc(data.autoBackup || '')}</code>. Tunggu beberapa detik lalu muat ulang halaman ini.</p>`
      toast('Pemulihan diterima — server sedang restart.')
    } catch (err) {
      box.innerHTML = `<p class="text-danger mb-0">${esc(err.message)}</p>`
    } finally {
      btn.disabled = false
    }
  })

  /* ---------- pembersihan ---------- */
  async function loadCleanup() {
    const data = await api('/api/admin/cleanup')
    const s = data.settings
    const cards = [
      { icon: 'bi-hammer', color: 'primary', label: 'Build lama', value: fmtNum(data.counts.builds), sub: `lebih lama dari ${s.retentionDays} hari` },
      { icon: 'bi-key', color: 'warning', label: 'Sesi kedaluwarsa', value: fmtNum(data.counts.sessions), sub: 'sesi login yang sudah lewat masa berlaku' },
      { icon: 'bi-activity', color: 'success', label: 'Preview berjalan', value: fmtNum(data.counts.previewsRunning), sub: 'tidak pernah dihentikan pembersihan' },
    ]
    $('#cleanup-cards').innerHTML = cards.map((c) => `<div class="col-sm-6 col-xl-4"><div class="card stats-card"><div class="card-body"><div class="d-flex align-items-center">
      <div class="flex-shrink-0"><div class="stats-icon bg-${c.color} bg-opacity-10 text-${c.color}"><i class="bi ${c.icon}"></i></div></div>
      <div class="flex-grow-1 ms-3"><p class="h6 mb-0 text-muted">${c.label}</p><div class="h5 mb-0">${c.value}</div><small class="text-muted">${c.sub}</small></div>
    </div></div></div>`).join('')
    $('#cleanup-retention').value = s.retentionDays
    $('#cleanup-auto').checked = !!s.auto
    const last = data.lastRun
    $('#cleanup-last-body').innerHTML = last
      ? `<dl class="row mb-0">
          <dt class="col-sm-5">Waktu</dt><dd class="col-sm-7">${esc(fmtDate(last.at))}</dd>
          <dt class="col-sm-5">Build dihapus</dt><dd class="col-sm-7">${fmtNum(last.builds)}</dd>
          <dt class="col-sm-5">Sesi dihapus</dt><dd class="col-sm-7">${fmtNum(last.sessions)}</dd>
          <dt class="col-sm-5">Preview dihapus</dt><dd class="col-sm-7">${fmtNum(last.previews)} (tidak pernah)</dd>
        </dl>`
      : '<p class="text-muted mb-0">Belum pernah ada pembersihan.</p>'
  }

  const cleanupRunBtn = $('#cleanup-run-btn')
  if (cleanupRunBtn) cleanupRunBtn.addEventListener('click', async () => {
    const ok = await confirmDialog('Jalankan pembersihan', 'Hapus sekarang semua build lama dan sesi kedaluwarsa sesuai retensi yang tersimpan? Preview yang berjalan tidak disentuh.', 'Ya, bersihkan')
    if (!ok) return
    try {
      const r = await api('/api/admin/cleanup/run', { method: 'POST' })
      toast(`Pembersihan selesai: ${fmtNum(r.deleted.builds)} build, ${fmtNum(r.deleted.sessions)} sesi dihapus.`)
      loadCleanup()
    } catch (err) { toast(err.message, 'error') }
  })

  const cleanupSettingsForm = $('#cleanup-settings-form')
  if (cleanupSettingsForm) cleanupSettingsForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      await api('/api/admin/cleanup/settings', { method: 'PUT', body: JSON.stringify({ retentionDays: Number($('#cleanup-retention').value), auto: $('#cleanup-auto').checked }) })
      toast('Pengaturan pembersihan disimpan.')
      loadCleanup()
    } catch (err) { toast(err.message, 'error') }
  })

  /* ---------- boot per-route ---------- */
  const refreshBtn = $('#refresh-btn')
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    try {
      const ov = await api('/api/admin/overview')
      overviewCache = ov
      fillNavBadges(ov)
      fillNotifications(ov)
      await loadPage(document.body.dataset.page || 'dashboard', ov)
      toast('Data dimuat ulang.')
    } catch (err) { toast(err.message, 'error') }
  })

  const logoutLink = $('#logout-link')
  if (logoutLink) logoutLink.addEventListener('click', async (e) => {
    e.preventDefault()
    try { await api('/api/auth/logout', { method: 'POST' }) } catch { /* abaikan */ }
    window.location.href = '/'
  })

  function showLocked(title, text, actionLabel) {
    $('#locked-title').textContent = title
    $('#locked-text').textContent = text
    const action = $('#locked-action')
    if (actionLabel) action.textContent = actionLabel
    action.href = '/'
    $('#locked-screen').classList.remove('d-none')
    const content = $('#page-content')
    if (content) content.classList.add('d-none')
  }

  async function boot() {
    const page = document.body.dataset.page || 'dashboard'
    try {
      const me = await api('/api/auth/me')
      if (!me.user) {
        showLocked('Masuk dulu', 'Panel admin hanya untuk akun yang sudah masuk. Masuk lewat Builder, lalu kembali ke sini.')
        $('#loading-screen').classList.add('done')
        return
      }
      window.__vbAdminMe = me.user.email
      const label = $('#user-email-label')
      if (label) label.textContent = me.user.email
      let ov
      try {
        ov = await api('/api/admin/overview')
      } catch (err) {
        if (err.status === 403) {
          showLocked('Bukan admin', `Akun ${me.user.email} bukan admin. Hanya pemilik instalasi yang bisa membuka panel ini.`, 'Kembali ke Builder')
          $('#loading-screen').classList.add('done')
          return
        }
        throw err
      }
      overviewCache = ov
      fillNavBadges(ov)
      fillNotifications(ov)
      $('#loading-screen').classList.add('done')
      await loadPage(page, ov)
    } catch (err) {
      $('#loading-screen').classList.add('done')
      toast(err.message, 'error')
    }
  }

  boot()
})()
