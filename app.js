(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem('wx.' + k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('wx.' + k, JSON.stringify(v)); } catch {} },
    del: k => { try { localStorage.removeItem('wx.' + k); } catch {} }
  };
  const DEFAULTS = { theme: 'system', temp: 'c', wind: 'kmh', pressure: 'hpa', vis: 'km' };
  let settings = { ...DEFAULTS, ...store.get('settings', {}) };
  let favs = store.get('favs', []), recents = store.get('recents', []);
  let loc = store.get('default', null) || store.get('last', null);
  let data = null, status = 'idle', errType = null, token = 0;

  /* ---------- icons ---------- */
  const CLOUD = 'M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 11a3.5 3.5 0 0 1-.5 7z', CLOUD_UP = 'M7 15a4 4 0 0 1-.5-8A6 6 0 0 1 18 8a3.5 3.5 0 0 1-.5 7z';
  const ICON = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    cloud: `<path d="${CLOUD}"/>`,
    partly: '<path d="M12 3v1.5M5.2 5.2l1 1M3 11h1.5M18.8 5.2l-1 1M8 11a4 4 0 0 1 6.5-3"/><path d="M8 20a3.5 3.5 0 0 1-.4-7 5 5 0 0 1 9.6 1.2A3 3 0 0 1 17 20z"/>',
    rain: `<path d="${CLOUD_UP}"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>`,
    snow: `<path d="${CLOUD_UP}"/><path stroke-width="3" d="M8 19h.01M12 19h.01M16 19h.01M10 22h.01M14 22h.01"/>`,
    storm: `<path d="${CLOUD_UP}"/><path d="M12 14l-2 4h4l-2 4"/>`,
    fog: '<path d="M4 8h16M3 12h18M6 16h12M9 20h6"/>',
    droplet: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 16h14a3 3 0 1 1-3 3M3 12h17"/>',
    gauge: '<circle cx="12" cy="12" r="9"/><path d="M12 12l4-3"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    thermo: '<path d="M10 4a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z"/>',
    sunrise: '<path d="M3 19h18M7 19a5 5 0 0 1 10 0M12 5v6M9 8l3-3 3 3"/>',
    sunset: '<path d="M3 19h18M7 19a5 5 0 0 1 10 0M12 5v6M9 8l3 3 3-3"/>'
  };
  const I = (n, s = 22) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

  /* ---------- unit + time formatting (data is stored metric) ---------- */
  const U = {
    temp: c => (settings.temp === 'f' ? Math.round(c * 9 / 5 + 32) : Math.round(c)) + '°',
    wind: k => settings.wind === 'mph' ? [Math.round(k * .621371), 'mph'] : settings.wind === 'ms' ? [(k / 3.6).toFixed(1), 'm/s'] : [Math.round(k), 'km/h'],
    press: h => settings.pressure === 'inhg' ? [(h * .02953).toFixed(2), 'inHg'] : [Math.round(h), 'hPa'],
    vis: m => settings.vis === 'mi' ? [(m / 1609.34).toFixed(1), 'mi'] : [(m / 1000).toFixed(1), 'km']
  };
  // Open-Meteo returns local wall-clock strings; parse them as UTC and format in UTC so the viewer's own timezone never leaks in.
  const fmt = (iso, o) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(new Date(iso + 'Z'));
  const clock = iso => fmt(iso, { hour: 'numeric', minute: '2-digit' });
  const localNow = () => new Date(Date.now() + data.location.offset * 1000).toISOString().slice(0, 16);
  const dayName = (date, i) => i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmt(date + 'T00:00', { weekday: 'long' });
  const dur = s => `${Math.floor(s / 3600)}h ${Math.round(s % 3600 / 60)}m`;
  const compass = d => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];
  const uvLabel = u => u < 3 ? 'Low' : u < 6 ? 'Moderate' : u < 8 ? 'High' : u < 11 ? 'Very high' : 'Extreme';
  const flag = c => c ? String.fromCodePoint(...[...c.toUpperCase()].map(x => 127397 + x.charCodeAt(0))) : '';
  const place = l => [l.region, l.country].filter(Boolean).join(', ');

  const MSG = {
    notfound: ["Couldn't find that location.", 'Try searching for a city, country, or region.'],
    api: ['Weather data is temporarily unavailable.', 'Please try again in a moment.'],
    offline: ["You're offline.", 'Check your internet connection and try again.'],
    rate: ['Too many requests right now.', 'Wait a minute, then try again.']
  };

  /* ---------- theme ---------- */
  function applyTheme() {
    const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('#unitBtn').textContent = settings.temp === 'f' ? '°F' : '°C';
  }
  const save = () => { store.set('settings', settings); applyTheme(); render(); };

  /* ---------- loading data ---------- */
  async function load(l) {
    loc = l; store.set('last', l); status = 'loading'; const my = ++token;
    if (!location.hash.startsWith('#/weather')) location.hash = '#/';
    render();
    try {
      const d = await WeatherAPI.getWeather(l);
      if (my !== token) return;
      data = d; status = 'ready';
      recents = [l, ...recents.filter(r => r.id !== l.id)].slice(0, 6); store.set('recents', recents);
      const c = WeatherAPI.condition(d.current.code, d.current.isDay);
      document.body.dataset.sky = c.sky;
    } catch (e) { if (my !== token) return; status = 'error'; errType = e.type || 'api'; }
    render();
  }

  /* ---------- views ---------- */
  const skeleton = () => `<div class="skel" style="height:300px"></div><div class="skel" style="height:140px"></div><div class="skel" style="height:140px"></div><div class="skel" style="height:240px"></div>`;
  const errorBox = type => `<div class="err card" role="alert"><h2>${MSG[type][0]}</h2><p>${MSG[type][1]}</p>${loc ? '<button class="btn" data-act="retry">Try again</button>' : ''}</div>`;

  function nowCard() {
    const c = data.current, w = WeatherAPI.condition(c.code, c.isDay), l = data.location, a = data.astronomy;
    const isFav = favs.some(f => f.id === l.id);
    return `<section class="now" aria-label="Current weather in ${esc(l.name)}">
      <div class="now-top"><div><h2>${esc(l.name)}</h2><p>${esc(place(l))}</p>
      <p>${fmt(localNow(), { weekday: 'long', month: 'long', day: 'numeric' })}, ${clock(localNow())} local time</p></div>
      <button class="fav" data-act="fav" aria-pressed="${isFav}">${isFav ? '★ Saved' : '☆ Save location'}</button></div>
      <div class="now-main"><div class="big" aria-label="${U.temp(c.temp)}">${U.temp(c.temp)}</div>
      <div>${I(w.icon, 56)}<p><b>${w.label}</b></p><p>Feels like ${U.temp(c.feels)}</p><p>High ${U.temp(c.high)} / Low ${U.temp(c.low)}</p></div></div>
      <div class="now-sun"><span>${I('sunrise')} Sunrise ${clock(a.sunrise)}</span><span>${I('sunset')} Sunset ${clock(a.sunset)}</span></div>
      <p class="m" style="color:#fff;opacity:.85">Observed ${clock(c.time)} local. Updated ${new Date(data.updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p></section>`;
  }

  function metrics() {
    const t = data.details, [ws, wu] = U.wind(t.wind), [ps, pu] = U.press(t.pressure), [vs, vu] = U.vis(t.visibility);
    const items = [
      ['droplet', 'Humidity', t.humidity, '%', ''], ['wind', 'Wind speed', ws, wu, `From the ${compass(t.windDir)} (${Math.round(t.windDir)}°)`],
      ['gauge', 'Pressure', ps, pu, ''], ['eye', 'Visibility', t.visibility == null ? null : vs, vu, ''],
      ['sun', 'UV index', t.uv == null ? null : t.uv.toFixed(1), '', t.uv == null ? '' : uvLabel(t.uv)],
      ['droplet', 'Precipitation', t.precip, 'mm', 'Last hour'], ['cloud', 'Cloud cover', t.clouds, '%', ''],
      ['thermo', 'Dew point', t.dew == null ? null : U.temp(t.dew), '', '']
    ].filter(i => i[2] != null);
    return `<div class="grid">${items.map(([ic, label, v, u, note]) => `<div class="card metric">${I(ic)}<p>${label}</p><b>${v} <small>${u}</small></b>${note ? `<p>${note}</p>` : ''}</div>`).join('')}</div>`;
  }

  function hourly(detailed) {
    return `<ol class="hours" tabindex="0" aria-label="Hourly forecast">${data.hourly.slice(0, detailed ? 48 : 24).map((h, i) => {
      const x = WeatherAPI.condition(h.code, h.isDay), [ws, wu] = U.wind(h.wind);
      return `<li class="hr${i ? '' : ' now'}"><b>${i ? fmt(h.time, { hour: 'numeric' }) : 'Now'}</b>${I(x.icon, 26)}<span class="t">${U.temp(h.temp)}</span>
      <span class="m">${h.pop ?? 0}% rain</span>${detailed ? `<span class="m">${x.label}</span><span class="m">${ws} ${wu}</span><span class="m">${h.humidity}% humid</span>` : ''}</li>`;
    }).join('')}</ol>`;
  }

  function daily(detailed) {
    const row = (d, i) => {
      const x = WeatherAPI.condition(d.code), extra = `<span>Sunrise ${clock(d.sunrise)}</span><span>Sunset ${clock(d.sunset)}</span><span>Daylight ${dur(d.daylight)}</span>
        <span>Rain ${d.rain} mm</span>${d.uv == null ? '' : `<span>UV max ${d.uv.toFixed(1)} (${uvLabel(d.uv)})</span>`}`;
      return `<details class="day"${detailed ? ' open' : ''}><summary><span><b>${dayName(d.date, i)}</b><br><span class="m">${fmt(d.date + 'T00:00', { month: 'short', day: 'numeric' })}</span></span>
        ${I(x.icon)}<span class="cond">${x.label}, ${d.pop ?? 0}% rain</span><span class="temps">${U.temp(d.high)} <span>${U.temp(d.low)}</span></span></summary><div class="more">${extra}</div></details>`;
    };
    return `<div class="days">${data.daily.slice(0, detailed ? 10 : 7).map(row).join('')}</div>`;
  }

  function sunBlock() {
    const a = data.astronomy;
    return `<div class="grid"><div class="card metric">${I('sunrise')}<p>Sunrise</p><b>${clock(a.sunrise)}</b></div><div class="card metric">${I('sunset')}<p>Sunset</p><b>${clock(a.sunset)}</b></div><div class="card metric">${I('sun')}<p>Day length</p><b>${dur(a.daylight)}</b></div></div>`;
  }

  function savedLists() {
    const li = (l, kind) => `<li><button class="link" data-act="open" data-kind="${kind}" data-id="${esc(l.id)}">${flag(l.code)} ${esc(l.name)}<span class="m"> ${esc(place(l))}</span></button>${kind === 'favs' ? `<button class="link" data-act="unfav" data-id="${esc(l.id)}" aria-label="Remove ${esc(l.name)} from favorites">Remove</button>` : ''}</li>`;
    return `<div class="two"><section class="card"><h3>Favorites</h3>${favs.length ? `<ul class="lst">${favs.map(l => li(l, 'favs')).join('')}</ul>` : '<p class="empty">You haven\'t saved any locations yet.</p>'}</section>
      <section class="card"><h3>Recent searches</h3>${recents.length ? `<ul class="lst">${recents.map(l => li(l, 'recents')).join('')}</ul><button class="link" data-act="clearRecents">Clear history</button>` : '<p class="empty">Your recent searches will appear here.</p>'}</section></div>`;
  }

  function weatherBody(detailed) {
    if (status === 'loading') return skeleton();
    if (status === 'error') return errorBox(errType);
    if (!data) return detailed ? '<div class="empty card"><p>Search for a location to see its detailed forecast.</p></div>' : '';
    const sec = (t, h) => `<h2>${t}</h2>${h}`;
    return nowCard() + sec('Conditions', metrics()) + sec(detailed ? 'Next 48 hours' : 'Hourly forecast', hourly(detailed)) +
      sec(detailed ? '10-day forecast' : '7-day forecast', daily(detailed)) + (detailed ? sec('Sunrise and sunset', sunBlock()) : '');
  }

  const seg = (key, label, opts) => `<fieldset class="seg"><legend>${label}</legend><div>${opts.map(([v, t]) =>
    `<span><input type="radio" id="${key}-${v}" name="${key}" value="${v}"${settings[key] === v ? ' checked' : ''}><label for="${key}-${v}">${t}</label></span>`).join('')}</div></fieldset>`;

  function settingsView() {
    return `<h2 style="margin-top:0">Settings</h2><div class="card">
      ${seg('theme', 'Appearance', [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']])}
      ${seg('temp', 'Temperature', [['c', 'Celsius'], ['f', 'Fahrenheit']])}
      ${seg('wind', 'Wind speed', [['kmh', 'km/h'], ['mph', 'mph'], ['ms', 'm/s']])}
      ${seg('pressure', 'Pressure', [['hpa', 'hPa'], ['inhg', 'inHg']])}
      ${seg('vis', 'Visibility', [['km', 'Kilometers'], ['mi', 'Miles']])}</div>
      <h2>Location</h2><div class="card prose"><p>Default location: <b>${store.get('default') ? esc(store.get('default').name) : 'none'}</b>. It loads automatically when you open the site.</p>
      <p class="m">Optional: the button below asks your browser for your position so we can show local weather. Coordinates are only sent to the weather provider to fetch the forecast.</p>
      <div class="acts"><button class="btn" data-act="geo">Use my current location</button>
      <button class="btn ghost" data-act="setDefault"${loc ? '' : ' disabled'}>Set ${loc ? esc(loc.name) : 'current location'} as default</button>
      <button class="btn ghost" data-act="clearDefault">Clear default</button></div></div>
      <h2>Data</h2><div class="card acts"><button class="btn ghost" data-act="clearRecents">Clear recent searches</button>
      <button class="btn ghost" data-act="clearFavs">Clear favorites</button><button class="btn danger" data-act="reset">Reset all settings</button></div>`;
  }

  const aboutView = () => `<div class="prose"><h2 style="margin-top:0">About Skyline</h2>
    <p>Skyline gives you current conditions, hourly and 10-day forecasts for any place in the world, in your own units and the location's own local time.</p>
    <h2>Weather data</h2><p>Forecasts and place search come from <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a>, licensed under CC BY 4.0. No account or API key is needed.</p>
    <h2>Accuracy</h2><p>Forecasts are estimates produced by weather models. They change as new data arrives, so check again before making plans that depend on the weather.</p>
    <h2>Privacy</h2><p>Favorites, recent searches and settings are stored only in your browser (localStorage). There is no account and nothing is sent to our servers. Search text and coordinates go to Open-Meteo to fetch results. Clear everything anytime in Settings.</p>
    <h2>Version</h2><p>Skyline 1.0.0</p></div>`;

  function render() {
    const page = (location.hash.replace('#/', '').split('?')[0]) || 'home';
    document.body.dataset.page = page;
    document.querySelectorAll('nav a').forEach(a => a.dataset.p === page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    const titles = { home: 'Weather Worldwide | Live Forecasts & Conditions', weather: 'Detailed Weather', about: 'About', settings: 'Settings' };
    document.title = (page === 'home' ? '' : (data && page === 'weather' ? data.location.name + ' ' : '') ) + titles[page] + (page === 'home' ? '' : ' | Skyline');
    $('#view').innerHTML = page === 'about' ? aboutView() : page === 'settings' ? settingsView()
      : weatherBody(page === 'weather') + (page === 'home' ? '<h2>Your places</h2>' + savedLists() : '');
    const sky = data && status === 'ready' ? WeatherAPI.condition(data.current.code, data.current.isDay).sky : 'clear';
    document.body.dataset.sky = sky;
  }

  /* ---------- search ---------- */
  const input = $('#q'), list = $('#results'), chips = $('#chips');
  let timer, results = [], active = -1, qToken = 0;
  chips.innerHTML = ['Riyadh', 'London', 'Tokyo', 'New York', 'Dubai', 'Paris'].map(c => `<button type="button" class="chip" data-city="${c}">${c}</button>`).join('');
  const closeList = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  function showList(msgKey) {
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
    list.innerHTML = msgKey ? `<li class="msg"><b>${MSG[msgKey][0]}</b><small>${MSG[msgKey][1]}</small></li>` :
      results.map((r, i) => `<li role="option" id="opt${i}" data-i="${i}" aria-selected="false">${flag(r.code)} <b>${esc(r.name)}</b><small>${esc(place(r))}</small></li>`).join('');
  }
  async function find(q) {
    const my = ++qToken;
    try { const r = await WeatherAPI.searchLocation(q); if (my !== qToken) return null; results = r; return r; }
    catch (e) { if (my === qToken) showList(e.type || 'api'); return null; }
  }
  async function suggest(q) { const r = await find(q); if (r) r.length ? showList() : showList('notfound'); }
  const pick = r => { closeList(); input.value = ''; load(r); };
  input.addEventListener('input', () => {
    clearTimeout(timer); const q = input.value.trim();
    if (q.length < 2) { qToken++; closeList(); return; }
    timer = setTimeout(() => suggest(q), 300);
  });
  input.addEventListener('keydown', e => {
    const opts = [...list.querySelectorAll('[role=option]')];
    if (e.key === 'Escape') closeList();
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && opts.length) {
      e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.setAttribute('aria-selected', i === active));
      input.setAttribute('aria-activedescendant', opts[active].id);
    }
  });
  list.addEventListener('click', e => { const li = e.target.closest('[data-i]'); if (li) pick(results[li.dataset.i]); });
  $('#searchForm').addEventListener('submit', async e => {
    e.preventDefault(); clearTimeout(timer);
    const q = input.value.trim(), shown = !list.hidden && results[active];
    if (shown) return pick(results[active]);
    if (!q) { list.hidden = false; list.innerHTML = '<li class="msg"><b>Enter a location.</b><small>Try a city, country, or postal code.</small></li>'; return; }
    $('#goBtn').textContent = 'Searching...';
    const r = await find(q); $('#goBtn').textContent = 'Search';
    if (r) r.length ? pick(r[0]) : showList('notfound');
  });
  chips.addEventListener('click', async e => {
    const c = e.target.dataset.city; if (!c) return;
    const r = await find(c); r && r.length ? pick(r[0]) : showList(r ? 'notfound' : 'api');
  });
  document.addEventListener('click', e => { if (!e.target.closest('#searchForm')) closeList(); });

  /* ---------- actions ---------- */
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    if (act === 'retry') load(loc);
    if (act === 'fav') {
      favs = favs.some(f => f.id === loc.id) ? favs.filter(f => f.id !== loc.id) : [...favs, loc]; store.set('favs', favs); render();
    }
    if (act === 'unfav') { favs = favs.filter(f => String(f.id) !== id); store.set('favs', favs); render(); }
    if (act === 'open') load((b.dataset.kind === 'favs' ? favs : recents).find(l => String(l.id) === id));
    if (act === 'clearRecents') { recents = []; store.set('recents', recents); render(); }
    if (act === 'clearFavs') { favs = []; store.set('favs', favs); render(); }
    if (act === 'setDefault') { store.set('default', loc); render(); }
    if (act === 'clearDefault') { store.del('default'); render(); }
    if (act === 'geo') {
      if (!navigator.geolocation) return alert('Your browser does not support location access.');
      navigator.geolocation.getCurrentPosition(p => load({ id: 'geo', name: 'Your location', region: '', country: '', code: '', lat: p.coords.latitude, lon: p.coords.longitude }),
        () => alert('Location access was blocked. You can still search for a place.'));
    }
    if (act === 'reset' && confirm('Reset settings, favorites, recent searches and default location? This cannot be undone.')) {
      ['settings', 'favs', 'recents', 'default', 'last'].forEach(store.del); settings = { ...DEFAULTS }; favs = []; recents = []; loc = null; data = null; status = 'idle'; save();
    }
  });
  $('#view').addEventListener('change', e => { if (e.target.name in DEFAULTS) { settings[e.target.name] = e.target.value; save(); } });
  $('#unitBtn').onclick = () => { settings.temp = settings.temp === 'c' ? 'f' : 'c'; save(); };
  $('#themeBtn').onclick = () => { settings.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; save(); };
  $('#menuBtn').onclick = e => { const o = $('#nav').classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', o); };
  $('#nav').onclick = () => $('#nav').classList.remove('open');
  addEventListener('hashchange', () => { render(); scrollTo(0, 0); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  setInterval(() => { if (data && document.visibilityState === 'visible' && Date.now() - data.updated > 15 * 60e3) load(loc); }, 60e3);

  applyTheme(); render();
  if (loc) load(loc);
})();
