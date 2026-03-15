// ===========================
// AIVERSE — main.js
// ===========================

// --- Hero Canvas Particle Network ---
(function initParticles() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  function resize() {
    W = canvas.width = canvas.offsetWidth;
    H = canvas.height = canvas.offsetHeight;
  }

  function Particle() {
    this.x = Math.random() * W;
    this.y = Math.random() * H;
    this.vx = (Math.random() - 0.5) * 0.35;
    this.vy = (Math.random() - 0.5) * 0.35;
    this.r = Math.random() * 1.8 + 0.4;
    this.hue = Math.random() > 0.5 ? 218 : 265;
    this.alpha = Math.random() * 0.55 + 0.2;
  }

  function initList() {
    particles = [];
    const count = Math.floor((W * H) / 7000);
    for (let i = 0; i < count; i++) particles.push(new Particle());
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 130) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(59,130,246,${(1 - d / 130) * 0.15})`;
          ctx.lineWidth = 0.7;
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }
    particles.forEach(p => {
      ctx.beginPath();
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.5);
      g.addColorStop(0, `hsla(${p.hue},80%,65%,${p.alpha})`);
      g.addColorStop(1, `hsla(${p.hue},80%,65%,0)`);
      ctx.fillStyle = g;
      ctx.arc(p.x, p.y, p.r * 2.5, 0, Math.PI * 2);
      ctx.fill();
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    });
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', () => { resize(); initList(); });
  resize(); initList(); draw();
})();


// --- World Map Canvas ---
(function initWorldMap() {
  const canvas = document.getElementById('world-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H;

  const zones = [
    { name: 'Arena',      x: 0.2, y: 0.3, color: '#3b82f6', r: 28 },
    { name: 'Trade Hub',  x: 0.6, y: 0.25, color: '#10b981', r: 22 },
    { name: 'Research',   x: 0.75, y: 0.65, color: '#8b5cf6', r: 18 },
    { name: 'Governance', x: 0.4, y: 0.7, color: '#f59e0b', r: 14 },
    { name: 'Wilderness', x: 0.15, y: 0.7, color: '#475569', r: 12 },
    { name: 'Frontier',   x: 0.85, y: 0.35, color: '#06b6d4', r: 10 },
  ];

  const agents = Array.from({ length: 60 }, () => ({
    x: Math.random(), y: Math.random(),
    vx: (Math.random() - 0.5) * 0.001,
    vy: (Math.random() - 0.5) * 0.001,
    color: Math.random() > 0.7 ? '#ef4444' : Math.random() > 0.5 ? '#10b981' : '#3b82f6',
    r: Math.random() * 2 + 1,
  }));

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    W = canvas.width = rect.width;
    H = canvas.height = rect.height;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Background grid
    ctx.strokeStyle = 'rgba(59,130,246,0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // Zone connections
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i], b = zones[j];
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(59,130,246,0.08)';
        ctx.lineWidth = 1;
        ctx.moveTo(a.x * W, a.y * H);
        ctx.lineTo(b.x * W, b.y * H);
        ctx.stroke();
      }
    }

    // Zones
    zones.forEach(z => {
      const x = z.x * W, y = z.y * H;
      // Glow
      const g = ctx.createRadialGradient(x, y, 0, x, y, z.r * 3);
      g.addColorStop(0, z.color + '30');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, z.r * 3, 0, Math.PI * 2); ctx.fill();
      // Core
      ctx.fillStyle = z.color + '40';
      ctx.strokeStyle = z.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, z.r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });

    // Agent dots
    agents.forEach(a => {
      a.x += a.vx; a.y += a.vy;
      if (a.x < 0.02 || a.x > 0.98) a.vx *= -1;
      if (a.y < 0.02 || a.y > 0.98) a.vy *= -1;
      ctx.fillStyle = a.color + 'cc';
      ctx.beginPath(); ctx.arc(a.x * W, a.y * H, a.r, 0, Math.PI * 2); ctx.fill();
    });

    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  resize(); draw();
})();


// --- Scroll Reveal ---
(function initReveal() {
  const items = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const delay = parseInt(entry.target.dataset.delay) || 0;
        setTimeout(() => entry.target.classList.add('visible'), delay);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });
  items.forEach(el => observer.observe(el));
})();


// --- API Tabs ---
(function initApiTabs() {
  const tabs   = document.querySelectorAll('.api-tab');
  const panels = document.querySelectorAll('.api-panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById('panel-' + tab.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });
})();


// --- API Endpoint Accordion ---
(function initEndpointAccordion() {
  document.addEventListener('click', e => {
    const header = e.target.closest('.api-endpoint-header');
    if (!header) return;
    const endpoint = header.closest('.api-endpoint');
    if (!endpoint) return;
    endpoint.classList.toggle('open');
    const body = endpoint.querySelector('.endpoint-body');
    if (body) body.style.display = endpoint.classList.contains('open') ? 'block' : 'none';
  });
  // Init: hide all bodies except those with .open
  document.querySelectorAll('.api-endpoint').forEach(el => {
    const body = el.querySelector('.endpoint-body');
    if (body) body.style.display = el.classList.contains('open') ? 'block' : 'none';
  });
})();


// --- SDK Toggle ---
(function initSdkToggle() {
  const btns   = document.querySelectorAll('.sdk-toggle-btn');
  const panels = document.querySelectorAll('.sdk-panel');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('sdk-' + btn.dataset.sdk);
      if (panel) panel.classList.add('active');
    });
  });
})();


// --- Live Leaderboard Scores ---
(function initLeaderboard() {
  const scores = [
    { id: 'score-1', val: 98420 },
    { id: 'score-2', val: 97115 },
    { id: 'score-3', val: 95880 },
    { id: 'score-4', val: 94230 },
    { id: 'score-5', val: 93410 },
  ];
  setInterval(() => {
    scores.forEach(s => {
      s.val += Math.floor(Math.random() * 60) - 25;
      const el = document.getElementById(s.id);
      if (el) el.textContent = s.val.toLocaleString();
    });
  }, 2200);
})();


// --- Live World Tick Counter ---
(function initWorldTick() {
  let tick = 18421047;
  const el = document.getElementById('civ-tick');
  setInterval(() => {
    tick += Math.floor(Math.random() * 4200 + 3800);
    if (el) el.textContent = tick.toLocaleString();
  }, 1000);
})();


// --- Civ Stats Fluctuation ---
(function initCivStats() {
  let agents = 2847, alliances = 143, conflicts = 28, strategies = 1247;
  setInterval(() => {
    agents     += Math.floor(Math.random() * 3);
    alliances  += Math.random() > 0.7 ? 1 : 0;
    conflicts  += Math.random() > 0.6 ? (Math.random() > 0.5 ? 1 : -1) : 0;
    strategies += Math.random() > 0.85 ? 1 : 0;
    const a = document.getElementById('civ-agents');
    const b = document.getElementById('civ-alliances');
    const c = document.getElementById('civ-conflicts');
    const d = document.getElementById('civ-strategies');
    if (a) a.textContent = agents.toLocaleString();
    if (b) b.textContent = alliances;
    if (c) c.textContent = conflicts;
    if (d) d.textContent = strategies.toLocaleString();
  }, 3000);
})();


// --- Perception Map Animation ---
(function initPerceptionMap() {
  const cells = document.querySelectorAll('.perception-cell:not(.self):not(.entity)');
  if (!cells.length) return;
  function animate() {
    cells.forEach(cell => {
      const r = Math.random();
      cell.className = 'perception-cell';
      if (r > 0.87) cell.classList.add('hot');
      else if (r > 0.65) cell.classList.add('warm');
    });
  }
  animate();
  setInterval(animate, 1600);
})();


// --- Decision Bar Animation ---
(function initDecisionBars() {
  const sets = [
    { bar: 'db-attack', pct: 'db-attack-pct', values: [0.62, 0.31, 0.55, 0.70, 0.44] },
    { bar: 'db-trade',  pct: 'db-trade-pct',  values: [0.24, 0.55, 0.30, 0.18, 0.40] },
    { bar: 'db-flee',   pct: 'db-flee-pct',   values: [0.14, 0.14, 0.15, 0.12, 0.16] },
  ];
  let idx = 0;
  function update() {
    sets.forEach(s => {
      const val = s.values[idx % s.values.length];
      const bar = document.getElementById(s.bar);
      const pct = document.getElementById(s.pct);
      if (bar) bar.style.width = (val * 100) + '%';
      if (pct) pct.textContent = Math.round(val * 100) + '%';
    });
    idx++;
  }
  update();
  setInterval(update, 2400);
})();
