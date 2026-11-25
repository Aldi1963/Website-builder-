/* VibeBuilder Admin — logika halaman. Semua data dari /api/admin/* (nyata). */
(function () {
  'use strict'

  const $ = (s, r) => (r || document).querySelector(s)
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s))

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  }
  const fmtNum = (n) => Number(n ?? 0).toLocaleString('id-ID')
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
  $('#confirm-yes').addEventListener('click', () => {
    bootstrap.Modal.getInstance($('#confirmModal')).hide()
    if (confirmResolve) confirmResolve(true)
  })
  $('#confirmModal').addEventListener('hidden.bs.modal', () => {
    if (confirmResolve) confirmResolve(false)
  })

  /* ---------- tema & sidebar ---------- */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme)
    $('#theme-icon-light').classList.toggle('d-none', theme !== 'light')
    $('#theme-icon-dark').classList.toggle('d-none', theme !== 'dark')
    try { localStorage.setItem('vb-admin-theme', theme) } catch { /* abaikan */ }
  }
  let savedTheme = 'light'
  try { savedTheme = localStorage.getItem('vb-admin-theme') || 'light' } catch { /* abaikan */ }
  applyTheme(savedTheme)
  $('#theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark')
  })
  $('#sidebar-toggle').addEventListener('click', () => {
    if (window.innerWidth < 992) document.body.classList.toggle('sidebar-open')
    else document.body.classList.toggle('sidebar-collapsed')
  })
  $('#sidebar-backdrop').addEventListener('click', () => document.body.classList.remove('sidebar-open'))

  /* ---------- modal form generik ---------- */
  let formResolve = null
  function formDialog(title, fields, values) {
    $('#form-title').textContent = title
    $('#form-body').innerHTML = fields.map((f) => {
      const val = values && values[f.name] !== undefined ? values[f.name] : (f.value ?? '')
      const help = f.help ? `<div class="form-text">${esc(f.help)}</div>` : ''
      if (f.type === 'textarea') {
        return `<div class="mb-3"><label class="form-label" for="form-${esc(f.name)}">${esc(f.label)}</label><textarea class="form-control" id="form-${esc(f.name)}" rows="3">${esc(val)}</textarea>${help}</div>`
      }
      return `<div class="mb-3"><label class="form-label" for="form-${esc(f.name)}">${esc(f.label)}</label><input type="${esc(f.type || 'text')}" class="form-control" id="form-${esc(f.name)}" value="${esc(val)}"${f.min !== undefined ? ` min="${f.min}"` : ''}${f.required ? ' required' : ''}>${help}</div>`
    }).join('')
    const modal = new bootstrap.Modal($('#formModal'))
    modal.show()
    return new Promise((resolve) => {
      formResolve = (v) => { resolve(v); formResolve = null }
    })
  }
  $('#form-save').addEventListener('click', () => {
    if (!formResolve) return
    const out = {}
    $$('#form-body input, #form-body textarea').forEach((el) => {
      const name = el.id.replace(/^form-/, '')
      out[name] = el.type === 'number' ? Number(el.value) : el.value
    })
    bootstrap.Modal.getInstance($('#formModal')).hide()
    formResolve(out)
  })
  $('#formModal').addEventListener('hidden.bs.modal', () => {
    if (formResolve) formResolve(null)
  })

  /* ---------- navigasi halaman ---------- */
  const pages = ['dashboard', 'users', 'projects', 'plans', 'usage', 'builds', 'messages', 'sessions', 'health', 'ai-settings', 'settings']
  const loaded = {}
  function showPage(name) {
    $$('section[data-page]').forEach((s) => s.classList.toggle('d-none', s.dataset.page !== name))
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name))
    document.body.dataset.page = name
    document.body.classList.remove('sidebar-open')
    $('#global-search').value = ''
    filterTables('')
    if (!loaded[name]) { loaded[name] = true; loadPage(name) }
    window.scrollTo(0, 0)
  }
  $$('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); showPage(a.dataset.nav) }))

  /* ---------- filter pencarian ---------- */
  function filterTables(q) {
    const query = (q || '').trim().toLowerCase()
    $$('table[data-filterable] tbody tr').forEach((tr) => {
      tr.style.display = !query || tr.textContent.toLowerCase().includes(query) ? '' : 'none'
    })
  }
  $('#global-search').addEventListener('input', (e) => filterTables(e.target.value))

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
  let usageCache = null

  async function loadPage(name) {
    try {
      if (name === 'dashboard') await loadDashboard()
      else if (name === 'users') await loadUsers()
      else if (name === 'projects') await loadProjects()
      else if (name === 'plans') await loadPlans()
      else if (name === 'usage') await loadUsage()
      else if (name === 'builds') await loadBuilds()
      else if (name === 'messages') await loadMessages()
      else if (name === 'sessions') await loadSessions()
      else if (name === 'health') await loadHealth()
      else if (name === 'ai-settings') await loadAiSettings()
      else if (name === 'settings') await loadSettings()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  async function loadDashboard() {
    const [ov, usage] = await Promise.all([api('/api/admin/overview'), api('/api/admin/usage')])
    overviewCache = ov
    usageCache = usage
    $('#stat-users').textContent = fmtNum(ov.users.total)
    $('#stat-users-sub').textContent = `+${fmtNum(ov.users.new7d)} dalam 7 hari · ${fmtNum(ov.users.disabled)} nonaktif`
    $('#stat-projects').textContent = fmtNum(ov.projects.total)
    $('#stat-projects-sub').textContent = `${fmtNum(ov.projects.published)} diterbitkan · +${fmtNum(ov.projects.new7d)} dalam 7 hari`
    $('#stat-messages').textContent = fmtNum(ov.messages.total)
    $('#stat-messages-sub').textContent = `${fmtNum(ov.messages.today)} hari ini · ${fmtNum(ov.messages.last7d)} dalam 7 hari`
    const tokens = ov.usage.promptTokens + ov.usage.completionTokens
    $('#stat-tokens').textContent = fmtNum(tokens)
    $('#stat-tokens-sub').textContent = `${fmtNum(ov.usage.requests)} permintaan · sejak server start`
    $('#nav-users-count').textContent = fmtNum(ov.users.total)
    $('#nav-projects-count').textContent = fmtNum(ov.projects.total)
    $('#dashboard-subtitle').textContent = `Diperbarui ${new Date().toLocaleTimeString('id-ID')} · semua angka dari database`

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
    feed.innerHTML = ov.recent.length
      ? ov.recent.map((r) => {
          const icon = r.kind === 'user' ? 'bi-person-plus' : r.kind === 'project' ? 'bi-box' : 'bi-hammer'
          return `<div class="activity-item"><div class="activity-icon"><i class="bi ${icon}"></i></div><div class="activity-content"><p class="mb-1">${esc(r.text)}</p><small class="text-muted">${esc(timeAgo(r.at))}</small></div></div>`
        }).join('')
      : '<p class="text-muted mb-0">Belum ada aktivitas.</p>'

    const statusEntries = Object.entries(ov.projects.byStatus || {})
    makeChart('statusChart', {
      type: 'doughnut',
      data: { labels: statusEntries.map(([k]) => k), datasets: [{ data: statusEntries.map(([, v]) => v), backgroundColor: [chartColors.blue, chartColors.green, chartColors.amber, chartColors.red, chartColors.slate] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
    })

    $('#top-users-body').innerHTML = ov.topUsers.length
      ? ov.topUsers.map((u) => `<tr><td><div class="d-flex align-items-center gap-2"><span class="avatar-sm">${esc((u.name || u.email || '?').trim().charAt(0).toUpperCase())}</span><span>${esc(u.name || u.email)}<br><small class="text-muted">${esc(u.email)}</small></span></div></td><td>${fmtNum(u.projects)}</td><td>${fmtNum(u.messages)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="text-muted">Belum ada data.</td></tr>'
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
        <td class="text-end">
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
          loaded.users = false; loadUsers()
        } catch (err) { toast(err.message, 'error') }
      } else {
        const ok = await confirmDialog('Hapus pengguna', `Hapus akun ${email} beserta SEMUA proyeknya? Tindakan ini tidak bisa dibatalkan.`, 'Ya, hapus')
        if (!ok) return
        try {
          const res = await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
          toast(`Akun ${email} dihapus (${fmtNum(res.deletedProjects)} proyek ikut terhapus).`)
          loaded.users = false; loadUsers()
          overviewCache = null
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
      <td class="text-end">
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
        loaded.projects = false; loadProjects()
        overviewCache = null
      } catch (err) { toast(err.message, 'error') }
    }))
  }

  async function loadUsage() {
    const data = await api('/api/admin/usage')
    usageCache = data
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
          <td class="text-end">
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
          loaded.plans = false; loadPlans()
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
        loaded.plans = false; loadPlans()
      } catch (err) { toast(err.message, 'error') }
    }))

    $$('#plan-users-body [data-plan-user]').forEach((sel) => sel.addEventListener('change', async () => {
      const userId = sel.dataset.planUser
      const planId = sel.value || null
      try {
        await api(`/api/admin/users/${encodeURIComponent(userId)}/plan`, { method: 'POST', body: JSON.stringify({ planId }) })
        toast('Plan pengguna diperbarui.')
        loaded.plans = false; loadPlans()
        loaded.users = false
      } catch (err) {
        toast(err.message, 'error')
        loaded.plans = false; loadPlans()
      }
    }))
  }

  $('#plan-add-btn').addEventListener('click', async () => {
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
      loaded.plans = false; loadPlans()
    } catch (err) { toast(err.message, 'error') }
  })

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

  $('#ai-settings-form').addEventListener('submit', async (e) => {
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
      loaded['ai-settings'] = false; loadAiSettings()
    } catch (err) { toast(err.message, 'error') }
  })

  $('#ai-test-btn').addEventListener('click', async () => {
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
          <td class="text-break">${esc(m.excerpt)}</td>
          <td>${esc(fmtDate(m.created_at))}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="text-muted">Tidak ada pesan.</td></tr>'
  }

  function runMessagesSearch() {
    messagesQuery = $('#messages-search').value.trim()
    loaded.messages = false; loadMessages()
  }
  $('#messages-search-btn').addEventListener('click', runMessagesSearch)
  $('#messages-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runMessagesSearch() } })

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
        loaded.sessions = false; loadSessions()
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

    const badge = $('#nav-health-badge')
    if (llm.reachable) { badge.className = 'badge rounded-pill ms-auto bg-success'; badge.textContent = 'OK' }
    else { badge.className = 'badge rounded-pill ms-auto bg-danger'; badge.textContent = 'LLM mati' }
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

  /* ---------- boot ---------- */
  $('#refresh-btn').addEventListener('click', async () => {
    Object.keys(loaded).forEach((k) => { loaded[k] = false })
    overviewCache = null
    usageCache = null
    await loadPage(document.body.dataset.page || 'dashboard')
    toast('Data dimuat ulang.')
  })

  $('#logout-link').addEventListener('click', async (e) => {
    e.preventDefault()
    try { await api('/api/auth/logout', { method: 'POST' }) } catch { /* abaikan */ }
    window.location.href = '/'
  })

  async function boot() {
    try {
      const me = await api('/api/auth/me')
      if (!me.user) {
        $('#locked-title').textContent = 'Masuk dulu'
        $('#locked-text').textContent = 'Panel admin hanya untuk akun yang sudah masuk. Masuk lewat Builder, lalu kembali ke sini.'
        $('#locked-screen').classList.remove('d-none')
        $$('section[data-page]').forEach((s) => s.classList.add('d-none'))
        $('#loading-screen').classList.add('done')
        return
      }
      window.__vbAdminMe = me.user.email
      $('#user-email-label').textContent = me.user.email
      try {
        await api('/api/admin/overview')
      } catch (err) {
        if (err.status === 403) {
          $('#locked-title').textContent = 'Bukan admin'
          $('#locked-text').textContent = `Akun ${me.user.email} bukan admin. Hanya pemilik instalasi yang bisa membuka panel ini.`
          $('#locked-action').textContent = 'Kembali ke Builder'
          $('#locked-action').href = '/'
          $('#locked-screen').classList.remove('d-none')
          $$('section[data-page]').forEach((s) => s.classList.add('d-none'))
          $('#loading-screen').classList.add('done')
          return
        }
        throw err
      }
      $('#loading-screen').classList.add('done')
      loaded.dashboard = true
      await loadDashboard()
    } catch (err) {
      $('#loading-screen').classList.add('done')
      toast(err.message, 'error')
    }
  }

  boot()
})()
