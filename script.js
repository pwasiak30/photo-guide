/* =====================================================================
   ZŁOTA GODZINA — script.js
   Logika aplikacji przeniesiona bez zmian funkcjonalnych z oryginalnego
   pliku inline <script> — zmieniono wyłącznie warstwę wizualną (style.css)
   i dodano obsługę przełącznika motywu jasny/ciemny poniżej.
===================================================================== */

/* ---------------------------------------------------------------------
   PRZEŁĄCZNIK MOTYWU (Dark/Light)
   Zapis w localStorage pod kluczem 'photo-guide-theme' — celowo INNYM
   niż klucze aplikacji (zg_favorites / zg_camera_brand), żeby nie
   kolidować z danymi użytkownika. Anty-FOUC ustawia data-theme wcześniej
   w <head> index.html; tu tylko synchronizujemy przycisk i nasłuch.
--------------------------------------------------------------------- */
(function () {
  'use strict';
  var STORAGE_KEY = 'photo-guide-theme';
  var root = document.documentElement;
  var toggleBtn = document.getElementById('theme-toggle');

  function getPreferredTheme() {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    if (toggleBtn) toggleBtn.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  function toggleTheme() {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
  }

  applyTheme(getPreferredTheme());
  if (toggleBtn) toggleBtn.addEventListener('click', toggleTheme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) applyTheme(e.matches ? 'dark' : 'light');
    } catch (err) {}
  });
})();

(function(){
  'use strict';

  // ---------- SunCalc: custom blue-hour times (PhotoPills convention: -4° do -8°) ----------
  SunCalc.addTime(-4, 'blueHourDawnEnd', 'blueHourDuskStart');
  SunCalc.addTime(-8, 'blueHourDawnStart', 'blueHourDuskEnd');
  // "Idealny moment" złotej godziny: słońce ok. 3° nad horyzontem (połowa zakresu 0°–6°) —
  // wystarczająco ciepłe/kierunkowe światło, a jednocześnie już dość intensywne.
  SunCalc.addTime(3, 'goldenHourPeakMorning', 'goldenHourPeakEvening');

  // ---------- Leaflet: fix default marker icon path (breaks when loaded from a CDN) ----------
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
  });

  var $ = function(id){ return document.getElementById(id); };

  var FAV_KEY = 'zg_favorites';
  var BRAND_KEY = 'zg_camera_brand';

  function loadFavoritesFromStorage(){
    try{ var raw = localStorage.getItem(FAV_KEY); var arr = raw ? JSON.parse(raw) : []; return Array.isArray(arr) ? arr : []; }
    catch(e){ return []; }
  }
  function loadBrandFromStorage(){
    try{ return localStorage.getItem(BRAND_KEY) || 'nikon'; }catch(e){ return 'nikon'; }
  }

  var state = {
    lat: null, lon: null, name: '', sub: '',
    tz: 'UTC',
    weather: null, // full open-meteo response
    map: null, mapLayer: null,
    favorites: loadFavoritesFromStorage(),
    cameraBrand: loadBrandFromStorage(),
    lastTimes: null,
    gearCamera: { nikon: null, canon: null },
    gearLens: { nikon: null, canon: null },
    gearScenario: null,
    sim: null,
    tle: { iss: null, css: null, error: false, loaded: false }
  };

  // ---------------- utils ----------------
  function pad(n){ return n<10 ? '0'+n : ''+n; }
  function ymd(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
  function isValidDate(d){ return d instanceof Date && !isNaN(d.getTime()); }

  function noonUTCFor(y,m,d){ return new Date(Date.UTC(y, m-1, d, 12, 0, 0)); }
  function parseYMD(str){
    var parts = str.split('-').map(Number);
    return { y: parts[0], m: parts[1], d: parts[2] };
  }

  function fmtTime(date){
    if(!isValidDate(date)) return '—';
    try{
      return date.toLocaleTimeString('pl-PL', {hour:'2-digit',minute:'2-digit', timeZone: state.tz});
    }catch(e){ return date.toLocaleTimeString('pl-PL', {hour:'2-digit',minute:'2-digit'}); }
  }
  function fmtDateLong(date){
    try{
      return date.toLocaleDateString('pl-PL', {weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone: state.tz});
    }catch(e){ return date.toLocaleDateString('pl-PL'); }
  }
  function fmtDateShort(date){
    try{
      return date.toLocaleDateString('pl-PL', {day:'2-digit', month:'2-digit', timeZone: state.tz});
    }catch(e){ return date.toLocaleDateString('pl-PL'); }
  }
  function fmtWeekday(date){
    try{
      return date.toLocaleDateString('pl-PL', {weekday:'short', timeZone: state.tz});
    }catch(e){ return ''; }
  }
  function localHourKey(date){
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: state.tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hour12:false
    }).formatToParts(date);
    var map = {};
    parts.forEach(function(p){ map[p.type] = p.value; });
    var hour = map.hour === '24' ? '00' : map.hour;
    return map.year + '-' + map.month + '-' + map.day + 'T' + hour + ':00';
  }
  function localDayKey(date){ return localHourKey(date).slice(0,10); }
  function nearestHourKey(date){
    var rounded = new Date(date.getTime() + 30*60000);
    return localHourKey(rounded);
  }

  function bearingFromAzimuth(azRad){
    var deg = azRad*180/Math.PI + 180;
    deg = ((deg % 360) + 360) % 360;
    return deg;
  }
  var COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  function compassLabel(deg){ return COMPASS[Math.round(deg/22.5) % 16]; }

  function destinationPoint(lat, lon, bearingDeg, distKm){
    var R = 6371;
    var brng = bearingDeg * Math.PI/180;
    var lat1 = lat*Math.PI/180, lon1 = lon*Math.PI/180;
    var lat2 = Math.asin(Math.sin(lat1)*Math.cos(distKm/R) + Math.cos(lat1)*Math.sin(distKm/R)*Math.cos(brng));
    var lon2 = lon1 + Math.atan2(Math.sin(brng)*Math.sin(distKm/R)*Math.cos(lat1), Math.cos(distKm/R)-Math.sin(lat1)*Math.sin(lat2));
    return [lat2*180/Math.PI, lon2*180/Math.PI];
  }

  function showStatus(msg){
    var s = $('status');
    s.textContent = msg;
    s.classList.remove('hidden');
  }
  function hideStatus(){ $('status').classList.add('hidden'); }

  // ---------------- favorites (persisted in localStorage — this is a standalone file, not a claude.ai artifact) ----------------
  function favKey(lat, lon){ return lat.toFixed(3) + ',' + lon.toFixed(3); }

  function persistFavorites(){
    try{ localStorage.setItem(FAV_KEY, JSON.stringify(state.favorites)); }catch(e){}
  }

  function isCurrentFavorited(){
    if(state.lat == null) return false;
    var k = favKey(state.lat, state.lon);
    for(var i=0;i<state.favorites.length;i++){
      if(favKey(state.favorites[i].lat, state.favorites[i].lon) === k) return true;
    }
    return false;
  }

  function updateFavToggleBtn(){
    var btn = $('favToggleBtn');
    if(state.lat == null){ btn.textContent = '☆ Dodaj do ulubionych'; btn.classList.remove('fav-active'); return; }
    if(isCurrentFavorited()){ btn.textContent = '★ W ulubionych — usuń'; btn.classList.add('fav-active'); }
    else { btn.textContent = '☆ Dodaj do ulubionych'; btn.classList.remove('fav-active'); }
  }

  function renderFavChips(){
    var box = $('favChips');
    if(!state.favorites.length){ box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var html = '';
    state.favorites.forEach(function(f, i){
      html += '<span class="fav-chip"><span class="fc-name" data-idx="' + i + '">⭐ ' + escapeHtml(f.name) + '</span><span class="fc-x" data-idx="' + i + '">✕</span></span>';
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('.fc-name'), function(el){
      el.addEventListener('click', function(){
        var f = state.favorites[parseInt(el.getAttribute('data-idx'), 10)];
        if(!f) return;
        $('placeInput').value = f.name;
        setLocation(f.lat, f.lon, f.name, f.sub);
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.fc-x'), function(el){
      el.addEventListener('click', function(e){
        e.stopPropagation();
        var idx = parseInt(el.getAttribute('data-idx'), 10);
        state.favorites.splice(idx, 1);
        persistFavorites();
        renderFavChips();
        updateFavToggleBtn();
      });
    });
  }

  $('favToggleBtn').addEventListener('click', function(){
    if(state.lat == null) return;
    var k = favKey(state.lat, state.lon);
    var idx = -1;
    for(var i=0;i<state.favorites.length;i++){
      if(favKey(state.favorites[i].lat, state.favorites[i].lon) === k){ idx = i; break; }
    }
    if(idx >= 0){ state.favorites.splice(idx, 1); }
    else { state.favorites.push({ name: state.name, sub: state.sub, lat: state.lat, lon: state.lon }); }
    persistFavorites();
    renderFavChips();
    updateFavToggleBtn();
  });

  // ---------------- geocoding ----------------
  var searchTimer = null;
  $('placeInput').addEventListener('input', function(){
    var q = this.value.trim();
    clearTimeout(searchTimer);
    if(q.length < 2){ $('suggestions').classList.add('hidden'); return; }
    searchTimer = setTimeout(function(){ doSearch(q); }, 350);
  });
  document.addEventListener('click', function(e){
    if(!e.target.closest('.search-wrap')) $('suggestions').classList.add('hidden');
  });

  function doSearch(q){
    fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) + '&count=8&language=pl&format=json')
      .then(function(r){ return r.json(); })
      .then(function(data){
        var box = $('suggestions');
        box.innerHTML = '';
        if(!data.results || !data.results.length){
          box.classList.add('hidden');
          return;
        }
        data.results.forEach(function(res){
          var div = document.createElement('div');
          div.className = 'sugg-item';
          var subParts = [res.admin1, res.country].filter(Boolean);
          div.innerHTML = '<div>' + res.name + '</div><small>' + subParts.join(', ') + '</small>';
          div.addEventListener('click', function(){
            $('placeInput').value = res.name;
            box.classList.add('hidden');
            setLocation(res.latitude, res.longitude, res.name, subParts.join(', '));
          });
          box.appendChild(div);
        });
        box.classList.remove('hidden');
      })
      .catch(function(){ $('suggestions').classList.add('hidden'); });
  }

  $('gpsBtn').addEventListener('click', function(){
    if(!navigator.geolocation){ showStatus('Twoja przeglądarka nie obsługuje geolokalizacji.'); return; }
    showStatus('Pobieranie lokalizacji GPS…');
    navigator.geolocation.getCurrentPosition(function(pos){
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      setLocation(lat, lon, 'Twoja lokalizacja', lat.toFixed(3) + ', ' + lon.toFixed(3));
      fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat + '&longitude=' + lon + '&localityLanguage=pl')
        .then(function(r){ return r.json(); })
        .then(function(d){
          var nm = d.city || d.locality || d.principalSubdivision || 'Twoja lokalizacja';
          var sub = [d.principalSubdivision, d.countryName].filter(Boolean).join(', ');
          state.name = nm; state.sub = sub;
          $('placeInput').value = nm;
          renderAll();
        })
        .catch(function(){});
    }, function(err){
      showStatus('Nie udało się pobrać lokalizacji: ' + err.message);
    }, { enableHighAccuracy:false, timeout:10000 });
  });

  // ---------------- date controls ----------------
  var today = new Date();
  $('dateInput').value = ymd(today);
  $('dateInput').addEventListener('change', function(){ if(state.lat!=null) renderAll(); });
  $('todayBtn').addEventListener('click', function(){
    $('dateInput').value = ymd(new Date());
    if(state.lat!=null) renderAll();
  });

  // ---------------- location + weather fetch ----------------
  function setLocation(lat, lon, name, sub){
    state.lat = lat; state.lon = lon; state.name = name; state.sub = sub || '';
    showStatus('Wczytywanie danych pogodowych…');
    $('results').classList.add('hidden');
    fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&hourly=cloudcover,precipitation_probability,visibility,temperature_2m&forecast_days=16&timezone=auto')
      .then(function(r){ return r.json(); })
      .then(function(data){
        state.weather = data;
        state.tz = data.timezone || 'UTC';
        hideStatus();
        $('results').classList.remove('hidden');
        renderAll();
        renderSatPasses();
      })
      .catch(function(err){
        state.weather = null;
        state.tz = 'UTC';
        showStatus('Nie udało się pobrać prognozy pogody (obliczenia astronomiczne nadal działają).');
        $('results').classList.remove('hidden');
        renderAll();
        renderSatPasses();
      });
  }

  // ---------------- przeloty stacji kosmicznych (ISS, Tiangong) ----------------
  var SAT_LIST = [
    { key:'iss', norad:25544, label:'ISS (Międzynarodowa Stacja Kosmiczna)', icon:'🛰️' },
    { key:'css', norad:48274, label:'Tiangong (chińska stacja kosmiczna)', icon:'🛰️' }
  ];
  var SAT_PASS_DAYS = 10;
  var MIN_PASS_ELEVATION = 10; // stopni nad horyzontem
  var DARK_SKY_SUN_ALT = -6;   // zmierzch cywilny lub ciemniej

  function loadTLE(){
    var promises = SAT_LIST.map(function(sat){
      return fetch('https://tle.ivanstanojevic.me/api/tle/' + sat.norad)
        .then(function(r){ if(!r.ok) throw new Error('tle fetch failed'); return r.json(); })
        .then(function(d){
          if(typeof satellite === 'undefined') return;
          state.tle[sat.key] = { name: d.name || sat.label, satrec: satellite.twoline2satrec(d.line1, d.line2) };
        })
        .catch(function(){ state.tle[sat.key] = null; });
    });
    return Promise.all(promises).then(function(){
      state.tle.loaded = true;
      state.tle.error = !state.tle.iss && !state.tle.css;
      if(state.lat != null) renderSatPasses();
    });
  }
  loadTLE();

  // Pozycja Słońca w układzie ECI (przybliżenie niskiej precyzji, wystarczające do
  // testu oświetlenia satelity — błąd rzędu ułamka stopnia).
  function sunEciVector(date){
    var jday = satellite.jday(date.getUTCFullYear(), date.getUTCMonth()+1, date.getUTCDate(),
      date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
    var n = jday - 2451545.0;
    var rad = Math.PI/180;
    var L = (280.460 + 0.9856474*n) % 360; if(L<0) L+=360;
    var g = ((357.528 + 0.9856003*n) % 360); if(g<0) g+=360; g*=rad;
    var lambda = (L + 1.915*Math.sin(g) + 0.020*Math.sin(2*g)) * rad;
    var epsilon = (23.439 - 0.0000004*n) * rad;
    var R = 1.00014 - 0.01671*Math.cos(g) - 0.00014*Math.cos(2*g);
    var AU = 149597870.7;
    return {
      x: R*Math.cos(lambda) * AU,
      y: R*Math.cos(epsilon)*Math.sin(lambda) * AU,
      z: R*Math.sin(epsilon)*Math.sin(lambda) * AU
    };
  }

  // Czy satelita jest oświetlony przez Słońce (uproszczony cylindryczny model cienia Ziemi).
  function satIsSunlit(satEci, sunVec){
    var satMag2 = satEci.x*satEci.x + satEci.y*satEci.y + satEci.z*satEci.z;
    var sunMag = Math.sqrt(sunVec.x*sunVec.x + sunVec.y*sunVec.y + sunVec.z*sunVec.z);
    var ux = sunVec.x/sunMag, uy = sunVec.y/sunMag, uz = sunVec.z/sunMag;
    var dot = satEci.x*ux + satEci.y*uy + satEci.z*uz;
    if(dot > 0) return true; // strona zwrócona ku Słońcu
    var perp2 = satMag2 - dot*dot;
    var EARTH_R = 6371;
    return perp2 > EARTH_R*EARTH_R;
  }

  // Znajduje widoczne przeloty (elewacja >= progu, satelita oświetlony, niebo obserwatora ciemne)
  // dla danego satrec, licząc od fromDate przez `days` dni, próbkując co 15 s w oknie zmierzch–świt.
  function findSatPasses(satrec, satMeta, fromDate, days, lat, lon){
    var rad = Math.PI/180;
    var observerGd = { longitude: lon*rad, latitude: lat*rad, height: 0.1 };
    var passes = [];
    // Pętla zaczyna się od d=-1, żeby złapać wciąż trwające okno ciemności, które
    // zaczęło się poprzedniego wieczoru (np. jeśli ktoś otwiera stronę o 3:00 nad ranem).
    for(var d = -1; d < days; d++){
      var dayNoon = noonUTCFor(fromDate.getUTCFullYear(), fromDate.getUTCMonth()+1, fromDate.getUTCDate()+d);
      var nextNoon = new Date(dayNoon.getTime() + 86400000);
      var t1 = SunCalc.getTimes(dayNoon, lat, lon);
      var t2 = SunCalc.getTimes(nextNoon, lat, lon);
      var start = t1.dusk, end = t2.dawn;
      if(isValidDate(start) && start < fromDate) start = fromDate;
      if(!isValidDate(start) || !isValidDate(end) || end <= start) continue;
      var stepMs = 15000;
      var inPass = false, cur = null;
      for(var t = start.getTime(); t <= end.getTime(); t += stepMs){
        var date = new Date(t);
        var gmst = satellite.gstime(date);
        var pv = satellite.propagate(satrec, date);
        if(!pv || !pv.position) continue;
        var ecf = satellite.eciToEcf(pv.position, gmst);
        var look = satellite.ecfToLookAngles(observerGd, ecf);
        var elDeg = look.elevation * 180/Math.PI;
        var azDeg = ((look.azimuth * 180/Math.PI) % 360 + 360) % 360;
        var visible = false;
        if(elDeg >= MIN_PASS_ELEVATION){
          var sunEl = SunCalc.getPosition(date, lat, lon).altitude * 180/Math.PI;
          visible = sunEl <= DARK_SKY_SUN_ALT && satIsSunlit(pv.position, sunEciVector(date));
        }
        if(visible){
          if(!inPass){ inPass = true; cur = { sat:satMeta, start:date, startAz:azDeg, max:date, maxEl:elDeg, maxAz:azDeg, end:date, endAz:azDeg }; }
          else {
            if(elDeg > cur.maxEl){ cur.maxEl = elDeg; cur.max = date; cur.maxAz = azDeg; }
            cur.end = date; cur.endAz = azDeg;
          }
        } else if(inPass){
          inPass = false;
          if(cur.end.getTime() - cur.start.getTime() >= 60000) passes.push(cur);
          cur = null;
        }
      }
      if(inPass && cur && cur.end.getTime() - cur.start.getTime() >= 60000) passes.push(cur);
    }
    return passes;
  }

  function renderSatPasses(){
    var el = $('satPassesCard');
    if(!el || state.lat == null) return;

    if(typeof satellite === 'undefined'){
      el.innerHTML = '<h2>🛰️ Przeloty stacji kosmicznych</h2><p class="note">Biblioteka do obliczeń orbitalnych (satellite.js) nie została załadowana — sprawdź połączenie z internetem i odśwież stronę.</p>';
      return;
    }
    if(!state.tle.loaded){
      el.innerHTML = '<h2>🛰️ Przeloty stacji kosmicznych</h2><p class="note">Wczytywanie aktualnych danych orbitalnych (TLE)…</p>';
      return;
    }
    if(!state.tle.iss && !state.tle.css){
      el.innerHTML = '<h2>🛰️ Przeloty stacji kosmicznych</h2><p class="note">Nie udało się pobrać aktualnych danych orbitalnych — spróbuj odświeżyć stronę za chwilę.</p>';
      return;
    }

    el.innerHTML = '<h2>🛰️ Przeloty stacji kosmicznych</h2><p class="note">Obliczanie widocznych przelotów dla Twojej lokalizacji…</p>';

    var lat = state.lat, lon = state.lon;
    setTimeout(function(){
      if(state.lat !== lat || state.lon !== lon) return; // lokalizacja zmieniła się w międzyczasie

      var now = new Date();
      var all = [];
      SAT_LIST.forEach(function(sat){
        var t = state.tle[sat.key];
        if(t) all = all.concat(findSatPasses(t.satrec, sat, now, SAT_PASS_DAYS, lat, lon));
      });
      all.sort(function(a,b){ return a.start.getTime() - b.start.getTime(); });

      var html = '<h2>🛰️ Przeloty stacji kosmicznych</h2>';
      html += '<p class="note">Widoczne przeloty ISS i chińskiej stacji Tiangong nad Twoją lokalizacją w ciągu najbliższych ' + SAT_PASS_DAYS + ' dni — stacja wygląda jak jasny, wolno przesuwający się punkt światła (bez migania, w przeciwieństwie do samolotu). Obliczone z aktualnych danych orbitalnych (TLE, pobranych teraz) — najdokładniejsze na najbliższe dni, później tracą precyzję, więc sprawdź ponownie bliżej terminu.</p>';

      if(!all.length){
        html += '<p class="note">Brak widocznych przelotów w najbliższych ' + SAT_PASS_DAYS + ' dniach dla tej lokalizacji. To normalne — stacje krążą non-stop, ale bywają widoczne (oświetlone Słońcem, przy ciemnym niebie obserwatora) tylko w pewnych okresach; „sezony widoczności” zmieniają się co kilka tygodni.</p>';
      } else {
        html += '<div class="astro-list">';
        all.forEach(function(p){
          var dateLabel = p.start.toLocaleDateString('pl-PL', {day:'2-digit', month:'2-digit', year:'numeric'});
          var durationMin = Math.max(1, Math.round((p.end.getTime() - p.start.getTime())/60000));
          var quality = p.maxEl >= 50 ? 'widowiskowy, wysoki przelot' : (p.maxEl >= 20 ? 'dobra widoczność' : 'nisko nad horyzontem — trudniejszy do zauważenia');
          html += '<div class="astro-item">' +
            '<div class="astro-icon">' + p.sat.icon + '</div>' +
            '<div class="astro-body">' +
              '<div class="astro-title-row"><b>' + escapeHtml(p.sat.label) + '</b><span class="astro-when">' + dateLabel + ', ' + fmtTime(p.start) + '–' + fmtTime(p.end) + '</span></div>' +
              '<div class="astro-hours">🕒 Widoczny ' + fmtTime(p.start) + '–' + fmtTime(p.end) + ' (' + durationMin + ' min)</div>' +
              '<div class="astro-best">👁️ <b>Najlepsza widoczność:</b> ok. ' + fmtTime(p.max) + ', maks. wysokość ' + Math.round(p.maxEl) + '° nad horyzontem, kierunek ' + compassLabel(p.maxAz) + ' — ' + quality + '.</div>' +
              '<div class="astro-detail">Pojawia się od strony ' + compassLabel(p.startAz) + ' (' + fmtTime(p.start) + ') → znika od strony ' + compassLabel(p.endAz) + ' (' + fmtTime(p.end) + ').</div>' +
            '</div>' +
          '</div>';
        });
        html += '</div>';
      }

      el.innerHTML = html;
    }, 30);
  }

  // ---------------- astronomy helpers ----------------
  function moonPhaseInfo(p){
    if(p < 0.03 || p > 0.97) return {name:'Nów', icon:'🌑'};
    if(p < 0.22) return {name:'Sierp rosnący', icon:'🌒'};
    if(p < 0.28) return {name:'Pierwsza kwadra', icon:'🌓'};
    if(p < 0.47) return {name:'Garb rosnący', icon:'🌔'};
    if(p < 0.53) return {name:'Pełnia', icon:'🌕'};
    if(p < 0.72) return {name:'Garb malejący', icon:'🌖'};
    if(p < 0.78) return {name:'Ostatnia kwadra', icon:'🌗'};
    return {name:'Sierp malejący', icon:'🌘'};
  }

  function findNextMoonEvents(fromDate){
    var prevPhase = SunCalc.getMoonIllumination(fromDate).phase;
    var nextNew = null, nextFull = null;
    for(var i=1;i<=32;i++){
      var d = new Date(fromDate.getTime() + i*86400000);
      var ph = SunCalc.getMoonIllumination(d).phase;
      if(!nextFull && prevPhase < 0.5 && ph >= 0.5) nextFull = d;
      if(!nextNew && prevPhase > ph) nextNew = d;
      prevPhase = ph;
      if(nextFull && nextNew) break;
    }
    return { nextNew: nextNew, nextFull: nextFull };
  }

  // ---------------- astronomical events (meteor showers, eclipses, supermoons) ----------------
  // Roje meteorów powtarzają się co roku w niemal tym samym terminie kalendarzowym —
  // daty szczytu i ZHR to uśrednione, ogólnie przyjęte wartości (IMO).
  var METEOR_SHOWERS = [
    { id:'quadrantids', name:'Kwadrantydy', peakMonth:1, peakDay:4, zhr:120, radiant:'Wolarz',
      note:'Krótki, ostry szczyt — najlepiej obserwować dokładnie w noc maksimum.' },
    { id:'lyrids', name:'Lyrydy', peakMonth:4, peakDay:22, zhr:18, radiant:'Lira',
      note:'Skromny, ale stabilny rój; czasem trafiają się jaśniejsze bolidy.' },
    { id:'etaAquariids', name:'Eta Akwarydy', peakMonth:5, peakDay:6, zhr:50, radiant:'Wodnik',
      note:'Pyłowy ślad komety Halleya; w Polsce radiant nisko nad horyzontem, lepszy widok z półkuli południowej.' },
    { id:'deltaAquariids', name:'Delta Akwarydy Południowe', peakMonth:7, peakDay:30, zhr:25, radiant:'Wodnik',
      note:'Rozmyty, długi szczyt — dobrze widoczny z dala od miejskich świateł.' },
    { id:'perseids', name:'Perseidy', peakMonth:8, peakDay:12, zhr:100, radiant:'Perseusz',
      note:'Najpopularniejszy rój roku — ciepłe noce, wysoka aktywność, świetny temat na zdjęcia z pierwszym planem.' },
    { id:'orionids', name:'Orionidy', peakMonth:10, peakDay:21, zhr:20, radiant:'Orion',
      note:'Pyłowy ślad komety Halleya; szybkie, jasne meteory.' },
    { id:'draconids', name:'Draconidy', peakMonth:10, peakDay:8, zhr:10, radiant:'Smok',
      note:'Zwykle skromny, ale bywa nieprzewidywalny — historycznie zdarzały się prawdziwe burze meteorów.' },
    { id:'leonids', name:'Leonidy', peakMonth:11, peakDay:17, zhr:15, radiant:'Lew',
      note:'Szybkie meteory; co ok. 33 lata potrafią dać prawdziwą burzę meteorów.' },
    { id:'geminids', name:'Geminidy', peakMonth:12, peakDay:14, zhr:150, radiant:'Bliźnięta',
      note:'Najlepszy i najbardziej niezawodny rój roku — jasne, powolne meteory.' },
    { id:'ursids', name:'Ursydy', peakMonth:12, peakDay:22, zhr:10, radiant:'Mała Niedźwiedzica',
      note:'Skromny rój tuż po przesileniu zimowym.' }
  ];

  // Realne daty zaćmień (NASA/EclipseWise/timeanddate) — trzeba aktualizować po 2030 roku.
  // hours/bestObserve/bestPhoto: godziny lokalne dla Polski (CET=UTC+1, CEST=UTC+2), null gdy zjawisko niewidoczne z Polski.
  var ECLIPSES = [
    { date:'2026-02-17', type:'Zaćmienie obrączkowe Słońca', icon:'🌑', pl:'Niewidoczne w Polsce — widoczne z Antarktydy i południowego Atlantyku.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2026-03-03', type:'Zaćmienie całkowite Księżyca', icon:'🌕', pl:'Niewidoczne w Polsce — całe zjawisko zachodzi w ciągu dnia (Księżyc jest wtedy pod horyzontem). Widoczne m.in. z Ameryki Północnej i Południowej, Pacyfiku oraz Azji Wschodniej.',
      hours:'Przebieg (niewidoczny z Polski): P1 09:44 – U1 10:50 – maks. 12:34 – U3 13:03 – P4 15:23 (CET)', bestObserve:null, bestPhoto:null },
    { date:'2026-08-12', type:'Zaćmienie całkowite Słońca', icon:'☀️', pl:'W Polsce widoczne jako częściowe, tuż przed zachodem Słońca — Słońce zachodzi jeszcze w trakcie zaćmienia (zasłonięcie tarczy do ok. 83–88%, zależnie od regionu). Pamiętaj o atestowanym filtrze słonecznym.',
      range:'19:15–20:08',
      hours:'Faza częściowa ok. 19:15–20:08 CEST (przerwana zachodem Słońca ok. 20:08)',
      bestObserve:'Maksimum ok. 20:00–20:05 — Słońce nisko nad horyzontem, ok. 83–88% tarczy zasłonięte. Obserwuj od 19:15, żeby złapać cały przebieg do zachodu.',
      bestPhoto:'Ok. 19:50–20:08 — sierp Słońca nisko nad horyzontem, można złapać w kadrze razem z krajobrazem (koniecznie z filtrem słonecznym na obiektywie do samego zachodu).' },
    { date:'2026-08-28', type:'Zaćmienie częściowe Księżyca', icon:'🌗', pl:'Niewidoczne w Polsce — widoczne z Azji Wschodniej, Australii, Pacyfiku i obu Ameryk.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2027-02-06', type:'Zaćmienie obrączkowe Słońca', icon:'🌑', pl:'Niewidoczne w Polsce — widoczne z Ameryki Południowej, Atlantyku i Afryki.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2027-02-20', type:'Zaćmienie półcieniowe Księżyca', icon:'🌕', pl:'Widoczne w Polsce, ale subtelne — zaćmienia półcieniowe trudno dostrzec gołym okiem.',
      range:'22:12–02:13',
      hours:'P1 22:12 – maks. 00:13 – P4 02:13 CET (noc z 20 na 21 lutego)',
      bestObserve:'Ok. 00:13 (maksimum) — wtedy przyciemnienie tarczy Księżyca jest najbardziej zauważalne, choć nadal subtelne.',
      bestPhoto:'Zrób serię zdjęć w oknie 23:30–00:45 i porównaj z ujęciem sprzed/po zaćmieniu, by uchwycić różnicę w jasności tarczy.' },
    { date:'2027-07-18', type:'Zaćmienie półcieniowe Księżyca', icon:'🌕', pl:'Niewidoczne w Polsce — widoczne z Azji Wschodniej, Australii, Pacyfiku i obu Ameryk.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2027-08-02', type:'Zaćmienie całkowite Słońca', icon:'☀️', pl:'Ścieżka całkowitości przez Maroko, Hiszpanię, Algierię, Libię, Egipt i Arabię Saudyjską — w Polsce możliwe tylko śladowe zaćmienie częściowe, sprawdź szczegóły bliżej terminu.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2027-08-17', type:'Zaćmienie półcieniowe Księżyca', icon:'🌕', pl:'Niewidoczne w Polsce — zjawisko zachodzi po wschodzie Słońca i zachodzie Księżyca. Widoczne głównie z Ameryk, Australii i Pacyfiku.',
      hours:'Przebieg (niewidoczny z Polski): P1 07:24 – maks. 09:14 – P4 11:03 (CEST)', bestObserve:null, bestPhoto:null },
    { date:'2028-01-12', type:'Zaćmienie częściowe Księżyca', icon:'🌗', pl:'Widoczne w Polsce, nad ranem — płytkie zaćmienie (zasłonięte ok. 7% tarczy).',
      range:'03:07–07:19',
      hours:'P1 03:07 – U1 04:45 – maks. 05:13 – U4 05:42 – P4 07:19 CET (rano 12 stycznia)',
      bestObserve:'Ok. 05:13 (maksimum) — obserwuj między U1 (04:45) a U4 (05:42), gdy cień jest najwyraźniejszy; Słońce wschodzi o ok. 07:40.',
      bestPhoto:'Fotografuj w oknie 04:45–05:45 — Księżyc będzie nisko nad zachodnim horyzontem, jeszcze przed świtem.' },
    { date:'2028-01-26', type:'Zaćmienie obrączkowe Słońca', icon:'🌑', pl:'Ścieżka przez Hiszpanię i Portugalię — w Polsce raczej niewidoczne.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2028-07-06', type:'Zaćmienie częściowe Księżyca', icon:'🌗', pl:'Niewidoczne w Polsce — widoczne z Azji Wschodniej, Australii, Pacyfiku i obu Ameryk.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2028-07-22', type:'Zaćmienie całkowite Słońca', icon:'☀️', pl:'Niewidoczne w Polsce — ścieżka całkowitości przez Australię i Nową Zelandię.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2028-12-31', type:'Zaćmienie całkowite Księżyca', icon:'🌕', pl:'Widoczne w Polsce od wschodu Księżyca (w trakcie fazy częściowej) — dobra okazja na sylwestrową fotografię Księżyca.',
      range:'16:07–20:40',
      hours:'Widoczne od wschodu Księżyca (ok. 15:33): U1 16:07 – początek całkowitości 17:16 – maks. 17:52 – koniec całkowitości 18:28 – U4 19:37 – P4 20:40 CET',
      bestObserve:'Całkowitość 17:16–18:28 (maksimum ok. 17:52) — zaczerwieniony Księżyc wysoko nad horyzontem, bardzo dobra widoczność w sylwestrowy wieczór.',
      bestPhoto:'Najlepsze ujęcia w trakcie całkowitości (17:16–18:28) — dłuższy czas naświetlania złapie czerwonawy odcień; ok. 16:00–16:30, tuż po wschodzie, zrób ujęcie z krajobrazem, gdy Księżyc jest jeszcze nisko i wygląda na większy.' },
    { date:'2029-01-14', type:'Zaćmienie częściowe Słońca', icon:'🌑', pl:'Niewidoczne w Polsce — widoczne z Ameryki Północnej.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2029-06-12', type:'Zaćmienie częściowe Słońca', icon:'🌑', pl:'Niewidoczne w Polsce — widoczne z Arktyki.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2029-06-26', type:'Zaćmienie całkowite Księżyca', icon:'🌕', pl:'W Polsce widoczny tylko początek zjawiska, nisko nad zachodnim horyzontem tuż przed świtem — całkowitość (najciemniejsza faza) zachodzi już po zachodzie Księżyca i NIE jest widoczna z Polski.',
      range:'02:35–04:00',
      hours:'Widoczne tylko: P1 02:35 – U1 03:32 CEST, potem Księżyc zachodzi (ok. 04:16, razem ze wschodem Słońca)',
      bestObserve:'Jedyne okno obserwacji: 02:35–04:00, nisko nad zachodnim horyzontem, zanim Księżyc zajdzie.',
      bestPhoto:'Fotografuj między 03:00 a 03:45 — potrzebny odsłonięty widok w kierunku zachodnim, nisko nad horyzontem.' },
    { date:'2029-12-05', type:'Zaćmienie częściowe Słońca', icon:'🌑', pl:'Niewidoczne w Polsce — widoczne z Antarktydy.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2029-12-20', type:'Zaćmienie całkowite Księżyca', icon:'🌕', pl:'Widoczne w Polsce przez całą noc — bardzo dobre warunki na obserwację i zdjęcia.',
      range:'20:43–02:41',
      hours:'P1 20:43 – U1 21:55 – U2 23:15 – maks. 23:42 – U3 00:09 – U4 01:29 – P4 02:41 CET (noc z 20 na 21 grudnia)',
      bestObserve:'Całkowitość 23:15–00:09 (maksimum ok. 23:42) — Księżyc wysoko na niebie, idealne warunki na obserwację czerwonego zaćmienia.',
      bestPhoto:'Sesja w oknie 23:15–00:09 na ujęcia całkowitości; dodatkowo 21:55–23:15 na serię pokazującą narastające zaciemnianie tarczy.' },
    { date:'2030-06-01', type:'Zaćmienie obrączkowe Słońca', icon:'🌑', pl:'Ścieżka przez Grecję i Turcję — w Polsce raczej niewidoczne lub tylko śladowo częściowe.',
      hours:null, bestObserve:null, bestPhoto:null },
    { date:'2030-11-25', type:'Zaćmienie całkowite Słońca', icon:'☀️', pl:'Niewidoczne w Polsce — ścieżka całkowitości przez południową Afrykę, Ocean Indyjski i Australię.',
      hours:null, bestObserve:null, bestPhoto:null }
  ];

  function nextMeteorShowerOccurrences(refDate){
    var refY = refDate.getUTCFullYear(), refM = refDate.getUTCMonth()+1, refD = refDate.getUTCDate();
    var refNum = refY*10000 + refM*100 + refD;
    return METEOR_SHOWERS.map(function(sh){
      var y = refY;
      var num = y*10000 + sh.peakMonth*100 + sh.peakDay;
      if(num < refNum) y += 1;
      return { shower: sh, date: new Date(Date.UTC(y, sh.peakMonth-1, sh.peakDay, 12, 0, 0)) };
    });
  }

  function upcomingEclipses(fromYMD, limit){
    return ECLIPSES.filter(function(e){ return e.date >= fromYMD; }).slice(0, limit || 6);
  }

  // Superksiężyc: powszechnie przyjęta definicja to jedna z ~3 pełni w danym roku
  // kalendarzowym najbliższych perygeum (najmniejszej odległości od Ziemi) —
  // dokładny próg w km różni się rok do roku, więc liczymy relatywnie, a nie po stałej wartości km.
  function fullMoonsInYear(year){
    var d0 = new Date(Date.UTC(year, 0, 1, 12, 0, 0));
    var d1 = new Date(Date.UTC(year + 1, 0, 20, 12, 0, 0));
    var results = [];
    var prevPhase = SunCalc.getMoonIllumination(d0).phase;
    var d = new Date(d0.getTime());
    while(d.getTime() < d1.getTime()){
      d = new Date(d.getTime() + 86400000);
      var ph = SunCalc.getMoonIllumination(d).phase;
      if(prevPhase < 0.5 && ph >= 0.5){
        results.push({ date: new Date(d.getTime()), distance: SunCalc.getMoonPosition(d, state.lat, state.lon).distance });
      }
      prevPhase = ph;
    }
    return results.filter(function(f){ return f.date.getUTCFullYear() === year; });
  }

  function findUpcomingSupermoons(fromDate, count){
    var years = [fromDate.getUTCFullYear(), fromDate.getUTCFullYear() + 1];
    var candidates = [];
    years.forEach(function(y){
      var fulls = fullMoonsInYear(y).slice();
      fulls.sort(function(a,b){ return a.distance - b.distance; });
      candidates = candidates.concat(fulls.slice(0, 3)); // 3 najbliższe pełnie roku = superksiężyce
    });
    candidates = candidates.filter(function(f){ return f.date.getTime() >= fromDate.getTime() - 12*3600000; });
    candidates.sort(function(a,b){ return a.date.getTime() - b.date.getTime(); });
    return candidates.slice(0, count).map(function(f){ return { date: f.date, distanceKm: Math.round(f.distance) }; });
  }

  // Okna bez Księżyca w danym przedziale czasu (próbkowanie co 15 min) — używane
  // zarówno przez "Niebo nocne" jak i przez godziny obserwacji wydarzeń astronomicznych.
  function moonlessWindows(start, end){
    if(!isValidDate(start) || !isValidDate(end) || end <= start) return [];
    var stepMs = 15*60000;
    var windows = [];
    var curStart = null;
    for(var t = start.getTime(); t <= end.getTime(); t += stepMs){
      var d = new Date(t);
      var pos = SunCalc.getMoonPosition(d, state.lat, state.lon);
      var below = pos.altitude < 0;
      if(below && curStart === null) curStart = d;
      if(!below && curStart !== null){ windows.push([curStart, d]); curStart = null; }
    }
    if(curStart !== null) windows.push([curStart, end]);
    return windows;
  }

  // Pełne okno ciemności (noc astronomiczna, z fallbackiem na zmierzch żeglarski/cywilny)
  // dla nocy zaczynającej się w dniu peakNoon (wieczór peakNoon -> rano dnia następnego),
  // plus "nadir" (przybliżona astronomiczna północ) do wyznaczenia drugiej połowy nocy.
  function nightWindowFor(peakNoon){
    var y = peakNoon.getUTCFullYear(), m = peakNoon.getUTCMonth()+1, d = peakNoon.getUTCDate();
    var eveNoon = noonUTCFor(y, m, d);
    var nextNoon = noonUTCFor(y, m, d + 1);
    var t1 = SunCalc.getTimes(eveNoon, state.lat, state.lon);
    var t2 = SunCalc.getTimes(nextNoon, state.lat, state.lon);
    var start = t1.night || t1.nauticalDusk || t1.dusk || t1.sunset;
    var end = t2.nightEnd || t2.nauticalDawn || t2.dawn || t2.sunrise;
    return { start:start, end:end, nadir:t2.nadir, duskStart:t1.sunset, dawnEnd:t2.sunrise };
  }

  // Wyznacza najlepsze okno obserwacji roju meteorów danej nocy: preferuje drugą
  // połowę nocy (po astronomicznej północy — radiant wyżej, mniej światła) i, jeśli
  // to możliwe, okno bez Księżyca nad horyzontem.
  function meteorBestWindow(win){
    if(!isValidDate(win.start) || !isValidDate(win.end) || win.end <= win.start) return null;
    var postMid = (isValidDate(win.nadir) && win.nadir > win.start && win.nadir < win.end) ? win.nadir : win.start;
    var mWindows = moonlessWindows(win.start, win.end);
    var best = null, bestOverlap = 0;
    mWindows.forEach(function(w){
      var os = Math.max(w[0].getTime(), postMid.getTime());
      var oe = Math.min(w[1].getTime(), win.end.getTime());
      if(oe - os > bestOverlap){ bestOverlap = oe - os; best = [new Date(os), new Date(oe)]; }
    });
    if(best) return { range: best, moonFree: true };
    if(mWindows.length){
      var largest = mWindows.reduce(function(a,b){ return (b[1]-b[0]) > (a[1]-a[0]) ? b : a; });
      return { range: largest, moonFree: true };
    }
    return { range: [postMid, win.end], moonFree: false };
  }

  function renderAstroEvents(dateNoon){
    var refY = dateNoon.getUTCFullYear(), refM = dateNoon.getUTCMonth()+1, refD = dateNoon.getUTCDate();
    var todayYMD = refY + '-' + pad(refM) + '-' + pad(refD);

    var showers = nextMeteorShowerOccurrences(dateNoon).map(function(o){
      var win = nightWindowFor(o.date);
      var hours, bestObserve, bestPhoto, rangeLabel = null;
      if(isValidDate(win.start) && isValidDate(win.end) && win.end > win.start){
        rangeLabel = fmtTime(win.start) + '–' + fmtTime(win.end);
        hours = 'Widoczne całą noc: ' + rangeLabel + ' (noc astronomiczna)';
        var best = meteorBestWindow(win);
        if(best){
          var rangeTxt = fmtTime(best.range[0]) + '–' + fmtTime(best.range[1]);
          bestObserve = rangeTxt + (best.moonFree
            ? ' — bez zakłóceń od Księżyca, druga połowa nocy (radiant wyżej nad horyzontem).'
            : ' — Księżyc będzie nad horyzontem całą noc, co ograniczy widoczność słabszych meteorów.');
          bestPhoto = 'Ustaw kadr i ognisko jeszcze przy świetle (przed ' + fmtTime(win.start) + '), a serie zdjęć/timelapse rób w oknie ' + rangeTxt + '.';
        }
      } else {
        hours = 'Brak pełnej nocy astronomicznej w tej lokalizacji i porze roku (białe noce) — obserwuj w najciemniejszej części nocy.';
        bestObserve = isValidDate(win.nadir) ? ('ok. ' + fmtTime(win.nadir) + ' (astronomiczna północ, najciemniejszy moment)') : null;
        bestPhoto = bestObserve ? ('Rób zdjęcia w okolicach ' + fmtTime(win.nadir) + ', gdy niebo jest najciemniejsze.') : null;
        rangeLabel = isValidDate(win.nadir) ? ('ok. ' + fmtTime(win.nadir)) : null;
      }
      return { date:o.date, icon:'☄️', title:o.shower.name,
        detail:'Szczyt aktywności · ZHR ~' + o.shower.zhr + '/h · radiant: ' + o.shower.radiant,
        note:o.shower.note, hours:hours, bestObserve:bestObserve, bestPhoto:bestPhoto, rangeLabel:rangeLabel };
    });

    var eclipses = upcomingEclipses(todayYMD, 6).map(function(e){
      var d = parseYMD(e.date);
      return { date: noonUTCFor(d.y, d.m, d.d), icon:e.icon, title:e.type, detail:e.pl, note:null,
        hours:e.hours || null, bestObserve:e.bestObserve || null, bestPhoto:e.bestPhoto || null, rangeLabel:e.range || null };
    });

    var supermoons = findUpcomingSupermoons(dateNoon, 2).map(function(s){
      var dayStart = new Date(Date.UTC(s.date.getUTCFullYear(), s.date.getUTCMonth(), s.date.getUTCDate(), 12, 0, 0));
      var mt = SunCalc.getMoonTimes(dayStart, state.lat, state.lon, true);
      var hours, bestObserve, bestPhoto, rangeLabel = null;
      if(mt.alwaysUp){
        hours = 'Księżyc nad horyzontem przez całą dobę.';
      } else if(mt.alwaysDown){
        hours = 'Księżyc pod horyzontem przez całą dobę w tej lokalizacji tego dnia.';
      } else if(isValidDate(mt.rise) || isValidDate(mt.set)){
        hours = 'Widoczny od wschodu (' + (isValidDate(mt.rise) ? fmtTime(mt.rise) : '—') + ') do zachodu Księżyca (' + (isValidDate(mt.set) ? fmtTime(mt.set) : '—') + ').';
      }
      if(isValidDate(mt.rise)){
        bestObserve = 'Cała noc, ale efekt najmocniejszy tuż po wschodzie (' + fmtTime(mt.rise) + ') lub tuż przed zachodem — złudzenie księżycowe sprawia, że nisko nad horyzontem Księżyc wygląda na większy.';
        bestPhoto = 'Ok. ' + fmtTime(mt.rise) + ' (wschód) — stań kilka–kilkanaście km od odległego obiektu (wieża, budynek, wzgórze) w linii z Księżycem i użyj teleobiektywu, by uchwycić go dużym tuż nad horyzontem.';
        rangeLabel = isValidDate(mt.set) ? (fmtTime(mt.rise) + '–' + fmtTime(mt.set)) : ('wschód ' + fmtTime(mt.rise));
      } else {
        bestObserve = 'Cała noc — pełnia widoczna niezależnie od pory.';
        bestPhoto = 'Fotografuj, gdy Księżyc jest nisko nad horyzontem (blisko wschodu lub zachodu), najlepiej z odległym obiektem w kadrze.';
      }
      return { date:s.date, icon:'🌝', title:'Superksiężyc (pełnia w perygeum)',
        detail:'Pełnia w odległości ok. ' + s.distanceKm.toLocaleString('pl-PL') + ' km od Ziemi — Księżyc widoczny nieco większy i jaśniejszy niż zwykle.',
        note:null, hours:hours, bestObserve:bestObserve, bestPhoto:bestPhoto, rangeLabel:rangeLabel };
    });

    var all = showers.concat(eclipses).concat(supermoons);
    all.sort(function(a,b){ return a.date.getTime() - b.date.getTime(); });
    all = all.slice(0, 8);

    var html = '<h2>🌠 Wydarzenia astronomiczne</h2>';
    html += '<p class="note">Najbliższe roje meteorów, zaćmienia i superksiężyce, licząc od wybranego dnia. Terminy rojów meteorów są coroczne i orientacyjne; zaćmienia — realne, konkretne daty. Godziny liczone dla wybranej lokalizacji i przeliczone na jej strefę czasową.</p>';

    if(!all.length){
      html += '<p class="note">Brak zaplanowanych wydarzeń w najbliższym czasie.</p>';
    } else {
      html += '<div class="astro-list">';
      all.forEach(function(ev){
        var daysUntil = Math.round((ev.date.getTime() - dateNoon.getTime()) / 86400000);
        var whenLabel = daysUntil === 0 ? 'dziś' : (daysUntil === 1 ? 'jutro' : ('za ' + daysUntil + ' dni'));
        var dateLabel = ev.date.toLocaleDateString('pl-PL', {day:'2-digit', month:'2-digit', year:'numeric'});
        var whenBadge = dateLabel + (ev.rangeLabel ? (', ' + ev.rangeLabel) : '') + ' · ' + whenLabel;
        html += '<div class="astro-item">' +
          '<div class="astro-icon">' + ev.icon + '</div>' +
          '<div class="astro-body">' +
            '<div class="astro-title-row"><b>' + escapeHtml(ev.title) + '</b><span class="astro-when">' + escapeHtml(whenBadge) + '</span></div>' +
            '<div class="astro-detail">' + escapeHtml(ev.detail) + '</div>' +
            (ev.hours ? '<div class="astro-hours">🕒 ' + escapeHtml(ev.hours) + '</div>' : '') +
            (ev.bestObserve ? '<div class="astro-best">👁️ <b>Najlepsza obserwacja:</b> ' + escapeHtml(ev.bestObserve) + '</div>' : '') +
            (ev.bestPhoto ? '<div class="astro-best">📷 <b>Najlepsze zdjęcia:</b> ' + escapeHtml(ev.bestPhoto) + '</div>' : '') +
            (ev.note ? '<div class="astro-note">💡 ' + escapeHtml(ev.note) + '</div>' : '') +
          '</div>' +
        '</div>';
      });
      html += '</div>';
    }

    $('astroEventsCard').innerHTML = html;
  }

  function conditionsScore(cloudPct){
    if(cloudPct == null || isNaN(cloudPct)) return null;
    if(cloudPct <= 20) return {emoji:'☀️', label:'Czyste niebo', desc:'Intensywne, klarowne światło i mocne cienie — efektowne, ale przewidywalne.', level:'mid'};
    if(cloudPct <= 60) return {emoji:'🌤️', label:'Warunki idealne', desc:'Chmury złapią kolor zachodzącego/wschodzącego słońca — duża szansa na spektakularne niebo.', level:'good'};
    if(cloudPct <= 90) return {emoji:'⛅', label:'Warunki umiarkowane', desc:'Możliwe dramatyczne niebo, ale słońce może być całkowicie zasłonięte w kluczowym momencie.', level:'mid'};
    return {emoji:'☁️', label:'Pełne zachmurzenie', desc:'Płaskie, rozproszone światło — mała szansa na kolorowe niebo, za to dobre warunki do portretów.', level:'bad'};
  }

  function cloudAt(dateObj){
    if(!state.weather || !state.weather.hourly) return null;
    var key = nearestHourKey(dateObj);
    var idx = state.weather.hourly.time.indexOf(key);
    if(idx === -1) return null;
    return state.weather.hourly.cloudcover[idx];
  }

  function dayAvgCloud(dayKey){
    if(!state.weather || !state.weather.hourly) return null;
    var vals = [];
    state.weather.hourly.time.forEach(function(t, i){
      if(t.indexOf(dayKey) === 0){
        var h = parseInt(t.slice(11,13), 10);
        if(h >= 6 && h <= 21) vals.push(state.weather.hourly.cloudcover[i]);
      }
    });
    if(!vals.length) return null;
    return Math.round(vals.reduce(function(a,b){return a+b;},0) / vals.length);
  }

  // ---------------- main render ----------------
  function renderAll(){
    if(state.lat == null) return;
    var dp = parseYMD($('dateInput').value);
    var dateNoon = noonUTCFor(dp.y, dp.m, dp.d);
    var nextNoon = noonUTCFor(dp.y, dp.m, dp.d + 1);
    var prevNoon = noonUTCFor(dp.y, dp.m, dp.d - 1);

    var times = SunCalc.getTimes(dateNoon, state.lat, state.lon);
    var timesNext = SunCalc.getTimes(nextNoon, state.lat, state.lon);
    var timesPrev = SunCalc.getTimes(prevNoon, state.lat, state.lon);

    var moonIllum = SunCalc.getMoonIllumination(dateNoon);
    var moonTimes = SunCalc.getMoonTimes(dateNoon, state.lat, state.lon, true);

    state.lastTimes = times;

    renderLocation(dateNoon);
    renderPhotoHours(times);
    renderCameraSettings();
    renderTimeline(times, timesNext);
    renderMoon(dateNoon, moonIllum, moonTimes);
    renderAstroEvents(dateNoon);
    renderWeather(times);
    renderDarkSky(times, timesNext);
    renderMap(times, moonTimes, moonIllum);
    renderCalendar(dp);

    renderDayLength(times, timesPrev);
  }

  function renderLocation(dateNoon){
    var html = '<div class="loc-name">📍 ' + escapeHtml(state.name || 'Wybrana lokalizacja') + '</div>';
    if(state.sub) html += '<div class="loc-sub">' + escapeHtml(state.sub) + '</div>';
    html += '<div class="loc-sub">Szer. ' + state.lat.toFixed(4) + '°, dł. ' + state.lon.toFixed(4) + '° · strefa: ' + state.tz + '</div>';
    html += '<div class="loc-date">' + capitalize(fmtDateLong(dateNoon)) + '</div>';
    $('locationCard').innerHTML = html;
    updateFavToggleBtn();
  }

  function renderPhotoHours(times){
    var html = '<h2>🎯 Godziny dla fotografa <span class="muted">zakres + idealny moment</span></h2>';
    html += '<div class="photo-hours">';

    function block(cls, title, startKey, endKey, peakKey){
      var s = times[startKey], e = times[endKey], p = times[peakKey];
      if(!isValidDate(s) && !isValidDate(e)) return '';
      var rangeStr = (isValidDate(s)?fmtTime(s):'—') + '–' + (isValidDate(e)?fmtTime(e):'—');
      var peakStr = isValidDate(p) ? fmtTime(p) : '—';
      return '<div class="hour-block ' + cls + '">' +
        '<div class="hb-title">' + title + '</div>' +
        '<div class="hb-range">' + rangeStr + '</div>' +
        '<div class="hb-peak">✨ Idealny moment: <b>' + peakStr + '</b></div>' +
        '</div>';
    }

    html += block('blue', '🔵 Niebieska — rano', 'blueHourDawnStart', 'blueHourDawnEnd', 'dawn');
    html += block('gold', '🟡 Złota — rano', 'sunrise', 'goldenHourEnd', 'goldenHourPeakMorning');
    html += block('gold', '🟡 Złota — wieczór', 'goldenHour', 'sunset', 'goldenHourPeakEvening');
    html += block('blue', '🔵 Niebieska — wieczór', 'blueHourDuskStart', 'blueHourDuskEnd', 'dusk');

    html += '</div>';
    html += '<p class="note">Zakres to cały czas trwania danej fazy światła — możesz fotografować przez całe okno. „Idealny moment” to punkt w tym zakresie o najbardziej charakterystycznym świetle: dla złotej godziny to chwila, gdy słońce jest ok. 3° nad horyzontem (ciepłe, kierunkowe światło, ale już wystarczająco intensywne); dla niebieskiej godziny — gdy słońce jest ok. 6° pod horyzontem (najlepsza równowaga między granatowym niebem a światłami miasta/sztucznym oświetleniem).</p>';

    $('photoHoursCard').innerHTML = html;
  }

  // ---------------- camera settings (Nikon / Canon) ----------------
  var LIGHT_CONDITIONS = [
    {
      key: 'blue', icon: '🔵', title: 'Niebieska godzina', mode: 'manual',
      aperture: 'f/8–f/11',
      shutter: 'statyw: 1–10 s · z ręki: 1/60–1/125 s',
      iso: 'statyw: 100–400 · z ręki: 800–3200',
      wb: '4000–4500 K',
      tip: '💡 Statyw + samowyzwalacz (2 s) albo pilot ograniczą drgania przy długich czasach naświetlania.'
    },
    {
      key: 'golden', icon: '🟡', title: 'Złota godzina', mode: 'aperturePriority',
      aperture: 'f/2.8–f/8 (szeroko = rozmyte tło, przymknięte = ostry krajobraz)',
      shutter: '1/125–1/1000 s',
      iso: '100–400',
      wb: '5000–5500 K',
      tip: '💡 Słońce za obiektem = kontur/flara, słońce z boku = modelunek. Osłona przeciwsłoneczna ograniczy odblaski.'
    },
    {
      key: 'midday', icon: '☀️', title: 'Południe (ostre słońce)', mode: 'aperturePriority',
      aperture: 'f/8–f/16',
      shutter: '1/500–1/2000 s',
      iso: '100',
      wb: '5200–6000 K',
      tip: '💡 Twarde, wysokie słońce — szukaj cienia/dyfuzora do portretów albo użyj polaryzatora, by wzmocnić niebo.'
    },
    {
      key: 'night', icon: '🌌', title: 'Noc / gwiazdy', mode: 'manual',
      aperture: 'f/1.4–f/2.8 (maksymalnie otwarta)',
      shutter: '10–25 s (reguła 500 ÷ ogniskowa)',
      iso: '1600–6400',
      wb: '3200–4000 K',
      tip: '💡 Ostrość ręcznie na nieskończoność (Live View + cyfrowy zoom na jasną gwiazdę), statyw obowiązkowy.'
    }
  ];

  var BRANDS = {
    nikon: {
      label: 'Nikon',
      dial: { aperturePriority: 'A — Priorytet przysłony', manual: 'M — Manual' },
      wbPath: 'WB → K (temperatura barwowa)',
      extra: {
        blue: '🔧 Active D-Lighting: Wył./Niski — nie spłaszczy głębokiego błękitu nieba.',
        golden: '🔧 Picture Control: Landscape/Vivid, Active D-Lighting: Wł. — wyrówna kontrast nieba i pierwszego planu.',
        midday: '🔧 Active D-Lighting: Wł. — odzyska prześwietlone niebo i niedoświetlone cienie.',
        night: '🔧 Long Exposure NR: Wył. (szybsze kolejne klatki), High ISO NR: Normal.'
      },
      cropNote: 'matryca DX (Nikon) → współczynnik przycięcia 1,5×'
    },
    canon: {
      label: 'Canon',
      dial: { aperturePriority: 'Av — Priorytet przysłony', manual: 'M — Manual' },
      wbPath: 'WB → K (Kelvin)',
      extra: {
        blue: '🔧 Auto Lighting Optimizer: Wył. — zachowa głęboki granat nieba.',
        golden: '🔧 Picture Style: Landscape, Auto Lighting Optimizer: Niski — nie spłaszczy ciepłych barw.',
        midday: '🔧 Auto Lighting Optimizer: Standardowy + filtr polaryzacyjny na mocne niebo.',
        night: '🔧 Long Exposure Noise Reduction: Wył., High ISO Speed NR: Standard.'
      },
      cropNote: 'matryca APS-C (Canon) → współczynnik przycięcia 1,6×'
    }
  };

  function renderCameraSettings(){
    var brand = state.cameraBrand === 'canon' ? 'canon' : 'nikon';
    var b = BRANDS[brand];
    var html = '<h2>📷 Ustawienia aparatu <span class="muted">punkt wyjścia</span></h2>';
    html += '<div class="brand-toggle">' +
      '<button type="button" class="brand-btn' + (brand==='nikon'?' active':'') + '" data-brand="nikon">Nikon</button>' +
      '<button type="button" class="brand-btn' + (brand==='canon'?' active':'') + '" data-brand="canon">Canon</button>' +
      '</div>';

    html += '<div class="cam-grid">';
    LIGHT_CONDITIONS.forEach(function(c){
      html += '<div class="cam-block">' +
        '<div class="cb-title">' + c.icon + ' ' + c.title + '</div>' +
        '<div class="cb-mode">Tryb: <b>' + b.dial[c.mode] + '</b></div>' +
        '<div class="cb-row"><span>Przysłona</span><b>' + c.aperture + '</b></div>' +
        '<div class="cb-row"><span>Czas</span><b>' + c.shutter + '</b></div>' +
        '<div class="cb-row"><span>ISO</span><b>' + c.iso + '</b></div>' +
        '<div class="cb-row"><span>Balans bieli</span><b>' + c.wb + '<span class="muted-inline">' + b.wbPath + '</span></b></div>' +
        '<div class="cb-tip">' + c.tip + '</div>' +
        '<div class="cb-tip">' + b.extra[c.key] + '</div>' +
        '</div>';
    });
    html += '</div>';

    html += '<p class="note">Reguła 500 dla gwiazd bez smug: 500 ÷ ogniskowa (mm) = maks. czas naświetlania w sekundach. Przy ' + b.cropNote + ' podziel wynik dodatkowo przez ten współczynnik. Powyższe wartości to sprawdzony punkt wyjścia — dostosuj je do konkretnej sceny, obiektywu i efektu, jaki chcesz uzyskać.</p>';

    $('cameraCard').innerHTML = html;

    Array.prototype.forEach.call(document.querySelectorAll('#cameraCard .brand-btn'), function(btn){
      btn.addEventListener('click', function(){ setCameraBrand(btn.getAttribute('data-brand')); });
    });
  }

  // shared brand switch — keeps the quick-reference card and the gear advisor tab in sync
  function setCameraBrand(brand){
    state.cameraBrand = brand === 'canon' ? 'canon' : 'nikon';
    try{ localStorage.setItem(BRAND_KEY, state.cameraBrand); }catch(e){}
    renderCameraSettings();
    if($('tabGearPanel') && !$('tabGearPanel').classList.contains('hidden')) renderGearCard();
  }

  // ---------------- lens & settings advisor ("Dobór sprzętu" tab) ----------------
  var GEAR = {
    nikon: {
      cameras: [
        { id:'z9', name:'Nikon Z9', crop:1.0, sensor:'pełna klatka' },
        { id:'z8', name:'Nikon Z8', crop:1.0, sensor:'pełna klatka' },
        { id:'z7ii', name:'Nikon Z7 II', crop:1.0, sensor:'pełna klatka' },
        { id:'z6iii', name:'Nikon Z6 III', crop:1.0, sensor:'pełna klatka' },
        { id:'z6ii', name:'Nikon Z6 II', crop:1.0, sensor:'pełna klatka' },
        { id:'z5ii', name:'Nikon Z5 II', crop:1.0, sensor:'pełna klatka' },
        { id:'zf', name:'Nikon Zf', crop:1.0, sensor:'pełna klatka' },
        { id:'d850', name:'Nikon D850', crop:1.0, sensor:'pełna klatka' },
        { id:'d780', name:'Nikon D780', crop:1.0, sensor:'pełna klatka' },
        { id:'d610', name:'Nikon D610', crop:1.0, sensor:'pełna klatka' },
        { id:'d600', name:'Nikon D600', crop:1.0, sensor:'pełna klatka' },
        { id:'d700', name:'Nikon D700', crop:1.0, sensor:'pełna klatka' },
        { id:'z50ii', name:'Nikon Z50 II', crop:1.5, sensor:'DX (APS-C)' },
        { id:'zfc', name:'Nikon Zfc', crop:1.5, sensor:'DX (APS-C)' },
        { id:'d7500', name:'Nikon D7500', crop:1.5, sensor:'DX (APS-C)' },
        { id:'d90', name:'Nikon D90', crop:1.5, sensor:'DX (APS-C)' },
        { id:'d80', name:'Nikon D80', crop:1.5, sensor:'DX (APS-C)' }
      ],
      lenses: [
        { id:'z1424', name:'Nikkor Z 14-24mm f/2.8 S', minF:14, maxF:24, maxAperture:2.8, type:'ultrawide' },
        { id:'z20', name:'Nikkor Z 20mm f/1.8 S', minF:20, maxF:20, maxAperture:1.8, type:'ultrawide-prime' },
        { id:'z2470', name:'Nikkor Z 24-70mm f/2.8 S', minF:24, maxF:70, maxAperture:2.8, type:'standard-zoom' },
        { id:'z24120', name:'Nikkor Z 24-120mm f/4 S', minF:24, maxF:120, maxAperture:4, type:'standard-zoom' },
        { id:'z35', name:'Nikkor Z 35mm f/1.8 S', minF:35, maxF:35, maxAperture:1.8, type:'prime-standard' },
        { id:'z50', name:'Nikkor Z 50mm f/1.8 S', minF:50, maxF:50, maxAperture:1.8, type:'prime-standard' },
        { id:'z85', name:'Nikkor Z 85mm f/1.8 S', minF:85, maxF:85, maxAperture:1.8, type:'prime-portrait' },
        { id:'z70200', name:'Nikkor Z 70-200mm f/2.8 VR S', minF:70, maxF:200, maxAperture:2.8, type:'tele-zoom' },
        { id:'zmc105', name:'Nikkor Z MC 105mm f/2.8 VR S (makro)', minF:105, maxF:105, maxAperture:2.8, type:'macro' },
        { id:'afs1424', name:'AF-S 14-24mm f/2.8G ED (F-mount)', minF:14, maxF:24, maxAperture:2.8, type:'ultrawide' },
        { id:'afs2470', name:'AF-S 24-70mm f/2.8E ED VR (F-mount)', minF:24, maxF:70, maxAperture:2.8, type:'standard-zoom' },
        { id:'afs70200', name:'AF-S 70-200mm f/2.8E FL ED VR (F-mount)', minF:70, maxF:200, maxAperture:2.8, type:'tele-zoom' },
        { id:'afs50', name:'AF-S 50mm f/1.8G (F-mount)', minF:50, maxF:50, maxAperture:1.8, type:'prime-standard' }
      ]
    },
    canon: {
      cameras: [
        { id:'r5ii', name:'Canon EOS R5 Mark II', crop:1.0, sensor:'pełna klatka' },
        { id:'r5', name:'Canon EOS R5', crop:1.0, sensor:'pełna klatka' },
        { id:'r6ii', name:'Canon EOS R6 Mark II', crop:1.0, sensor:'pełna klatka' },
        { id:'r6', name:'Canon EOS R6', crop:1.0, sensor:'pełna klatka' },
        { id:'r8', name:'Canon EOS R8', crop:1.0, sensor:'pełna klatka' },
        { id:'r', name:'Canon EOS R', crop:1.0, sensor:'pełna klatka' },
        { id:'5d4', name:'Canon EOS 5D Mark IV', crop:1.0, sensor:'pełna klatka' },
        { id:'6d2', name:'Canon EOS 6D Mark II', crop:1.0, sensor:'pełna klatka' },
        { id:'r7', name:'Canon EOS R7', crop:1.6, sensor:'APS-C' },
        { id:'r10', name:'Canon EOS R10', crop:1.6, sensor:'APS-C' },
        { id:'r50', name:'Canon EOS R50', crop:1.6, sensor:'APS-C' },
        { id:'90d', name:'Canon EOS 90D', crop:1.6, sensor:'APS-C' }
      ],
      lenses: [
        { id:'rf1535', name:'RF 15-35mm f/2.8L IS', minF:15, maxF:35, maxAperture:2.8, type:'ultrawide' },
        { id:'rf16', name:'RF 16mm f/2.8 STM', minF:16, maxF:16, maxAperture:2.8, type:'ultrawide-prime' },
        { id:'rf2470', name:'RF 24-70mm f/2.8L IS', minF:24, maxF:70, maxAperture:2.8, type:'standard-zoom' },
        { id:'rf24105', name:'RF 24-105mm f/4L IS', minF:24, maxF:105, maxAperture:4, type:'standard-zoom' },
        { id:'rf35', name:'RF 35mm f/1.8 IS Macro STM', minF:35, maxF:35, maxAperture:1.8, type:'prime-standard' },
        { id:'rf50', name:'RF 50mm f/1.8 STM', minF:50, maxF:50, maxAperture:1.8, type:'prime-standard' },
        { id:'rf85', name:'RF 85mm f/1.2L', minF:85, maxF:85, maxAperture:1.2, type:'prime-portrait' },
        { id:'rf70200', name:'RF 70-200mm f/2.8L IS', minF:70, maxF:200, maxAperture:2.8, type:'tele-zoom' },
        { id:'rf100macro', name:'RF 100mm f/2.8L Macro IS (makro)', minF:100, maxF:100, maxAperture:2.8, type:'macro' },
        { id:'ef1635', name:'EF 16-35mm f/2.8L III (EF-mount)', minF:16, maxF:35, maxAperture:2.8, type:'ultrawide' },
        { id:'ef2470', name:'EF 24-70mm f/2.8L II (EF-mount)', minF:24, maxF:70, maxAperture:2.8, type:'standard-zoom' },
        { id:'ef70200', name:'EF 70-200mm f/2.8L IS III (EF-mount)', minF:70, maxF:200, maxAperture:2.8, type:'tele-zoom' },
        { id:'ef50', name:'EF 50mm f/1.8 STM (EF-mount)', minF:50, maxF:50, maxAperture:1.8, type:'prime-standard' }
      ]
    }
  };

  var SCENARIOS = [
    { id:'goldenLandscape', label:'🟡 Złota godzina — krajobraz', idealTypes:['ultrawide','ultrawide-prime','standard-zoom'], idealFocal:[14,35],
      aperture:'f/8–f/11 (głębia ostrości)', shutterHint:'1/125–1/500 s', iso:'100–200', wb:'5000–5500 K',
      note:'Szeroki kąt pokaże całą scenę i niebo; przymknięta przysłona utrzyma ostrość od pierwszego planu po horyzont.',
      defAperture:11, defShutterSec:1/250, defISO:100, defWB:5200, focalBias:'wide' },
    { id:'goldenPortrait', label:'🟡 Złota godzina — portret', idealTypes:['prime-portrait','prime-standard','tele-zoom'], idealFocal:[50,135],
      aperture:'f/1.8–f/4 (rozmyte tło)', shutterHint:'1/250–1/1000 s', iso:'100–200', wb:'5000–5500 K',
      note:'Ustaw słońce za modelem (rim light/kontra) i doświetl twarz reflektorem lub lampą błyskową.',
      defAperture:2.8, defShutterSec:1/500, defISO:100, defWB:5200, focalBias:'tele' },
    { id:'blueCityscape', label:'🔵 Niebieska godzina — architektura/miasto', idealTypes:['ultrawide','ultrawide-prime','standard-zoom'], idealFocal:[14,35],
      aperture:'f/8–f/11', shutterHint:'statyw: 1–15 s', iso:'100–400', wb:'4000–4500 K',
      note:'Statyw obowiązkowy — długi czas pokaże smugi świateł samochodów i rozświetlone okna budynków.',
      defAperture:8, defShutterSec:4, defISO:200, defWB:4200, focalBias:'wide' },
    { id:'night', label:'🌌 Noc — astrofotografia / Droga Mleczna', idealTypes:['ultrawide','ultrawide-prime'], idealFocal:[14,24],
      aperture:'najszersza dostępna', shutterHint:'reguła 500 (patrz niżej)', iso:'1600–6400', wb:'3200–4000 K',
      note:'Im szerszy i jaśniejszy obiektyw, tym dłuższy dopuszczalny czas naświetlania bez smużenia gwiazd.',
      defAperture:1.4, useMaxAperture:true, defShutterSec:20, defISO:3200, defWB:3600, focalBias:'wide' },
    { id:'midday', label:'☀️ Południe — ostre słońce', idealTypes:['standard-zoom','ultrawide'], idealFocal:[16,70],
      aperture:'f/8–f/16', shutterHint:'1/500–1/2000 s', iso:'100', wb:'5200–6000 K',
      note:'Filtr polaryzacyjny wzmocni niebo i zredukuje odblaski; szukaj cienia albo dyfuzora do portretów.',
      defAperture:11, defShutterSec:1/1000, defISO:100, defWB:5500, focalBias:'normal' },
    { id:'wildlife', label:'🦅 Dzika przyroda / sport', idealTypes:['tele-zoom'], idealFocal:[200,600],
      aperture:'najszersza dostępna', shutterHint:'1/1000–1/4000 s', iso:'400–3200 (Auto ISO)', wb:'Auto WB',
      note:'Włącz tryb ciągły (burst) i śledzenie AF na oko/obiekt w ruchu.',
      defAperture:4, useMaxAperture:true, defShutterSec:1/2000, defISO:800, defWB:5500, focalBias:'tele' },
    { id:'macro', label:'🔍 Makro (owady, kwiaty, detale)', idealTypes:['macro'], idealFocal:[60,105],
      aperture:'f/8–f/16 (większa głębia ostrości)', shutterHint:'1/125–1/250 s (lub statyw + lampa)', iso:'200–800', wb:'Auto WB / dzienne',
      note:'Przy powiększeniu bliskim 1:1 głębia ostrości jest ekstremalnie płytka — przymknij przysłonę, rozważ statyw.',
      defAperture:11, defShutterSec:1/200, defISO:400, defWB:5500, focalBias:'tele' }
  ];

  var GEAR_TYPE_LABELS = {
    'ultrawide':'szerokokątny zoom', 'ultrawide-prime':'szerokokątny stały',
    'standard-zoom':'standardowy zoom', 'prime-standard':'stały normalny',
    'prime-portrait':'portretowy stały', 'tele-zoom':'teleobiektyw zoom',
    'macro':'makro'
  };

  function findById(list, id){
    for(var i=0;i<list.length;i++){ if(list[i].id === id) return list[i]; }
    return null;
  }

  // ---------------- live settings simulator ----------------
  var APERTURE_STOPS = [1,1.2,1.4,1.8,2,2.8,4,5.6,8,11,16,22];
  var SHUTTER_STOPS = [1/4000,1/2000,1/1000,1/500,1/250,1/125,1/60,1/30,1/15,1/8,1/4,1/2,1,2,4,8,15,20,30];
  var ISO_STOPS = [100,200,400,800,1600,3200,6400,12800];

  var PHOTO_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/Crops_at_golden_hour.jpg/1280px-Crops_at_golden_hour.jpg';
  var PHOTO_CREDIT_HTML = '📷 Zdjęcie: <a href="https://commons.wikimedia.org/wiki/File:Crops_at_golden_hour.jpg" target="_blank" rel="noopener">„Crops at golden hour”</a>, autor GlaasG50, licencja <a href="https://creativecommons.org/licenses/by-sa/4.0" target="_blank" rel="noopener">CC BY-SA 4.0</a> (Wikimedia Commons)';

  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  function nearestIndexLog(arr, val){
    var bestI = 0, bestD = Infinity;
    for(var i=0;i<arr.length;i++){
      var d = Math.abs(Math.log(arr[i]) - Math.log(val));
      if(d < bestD){ bestD = d; bestI = i; }
    }
    return bestI;
  }

  function fmtShutter(sec){
    if(sec >= 1){
      var r = Math.round(sec*10)/10;
      return (Math.abs(r - Math.round(r)) < 0.05 ? Math.round(r) : r) + ' s';
    }
    var denom = Math.round(1/sec);
    return '1/' + denom + ' s';
  }

  function getAchievableApertures(lens){
    var arr = APERTURE_STOPS.filter(function(a){ return a >= lens.maxAperture - 0.01; });
    if(arr.length === 0 || Math.abs(arr[0] - lens.maxAperture) > 0.05){
      arr = [lens.maxAperture].concat(arr);
    }
    return arr;
  }

  function computeGearRecommendation(brand, cameraId, lensId, scenarioId){
    var g = GEAR[brand];
    var cam = findById(g.cameras, cameraId);
    var lens = findById(g.lenses, lensId);
    var scenario = findById(SCENARIOS, scenarioId);
    if(!cam || !lens || !scenario) return null;

    var effMin = Math.round(lens.minF * cam.crop);
    var effMax = Math.round(lens.maxF * cam.crop);
    var effLabel = effMin === effMax ? (effMin + 'mm') : (effMin + '–' + effMax + 'mm');

    var typeMatch = scenario.idealTypes.indexOf(lens.type) !== -1;
    var focalOverlap = !(effMax < scenario.idealFocal[0] || effMin > scenario.idealFocal[1]);
    var suited = typeMatch || focalOverlap;

    var apertureText = scenario.aperture.indexOf('najszersza dostępna') !== -1
      ? ('f/' + lens.maxAperture + ' (najszersza w tym obiektywie)')
      : scenario.aperture;

    var shutterText = scenario.shutterHint;
    if(scenario.id === 'night'){
      var focalForRule = effMax || effMin;
      var maxSec = Math.round((500 / focalForRule) * 10) / 10;
      shutterText = 'maks. ok. ' + maxSec + ' s bez smużenia gwiazd (500 ÷ ' + focalForRule + 'mm efekt. ogniskowej)';
    }

    return {
      cam: cam, lens: lens, scenario: scenario,
      effLabel: effLabel, suited: suited,
      apertureText: apertureText, shutterText: shutterText,
      iso: scenario.iso, wb: scenario.wb, note: scenario.note
    };
  }

  function describeIdealTypes(scenario){
    var labels = scenario.idealTypes.map(function(t){ return GEAR_TYPE_LABELS[t] || t; });
    return labels.join(', ') + ' (ok. ' + scenario.idealFocal[0] + '–' + scenario.idealFocal[1] + 'mm)';
  }

  function renderGearResult(rec){
    var box = $('gearResult');
    if(!box) return;
    if(!rec){ box.innerHTML = ''; return; }

    var html = rec.suited
      ? '<div class="gear-verdict good">✅ Ten obiektyw dobrze pasuje do wybranej sceny.</div>'
      : '<div class="gear-verdict warn">⚠️ Ten obiektyw nie jest idealny do tej sceny — zobacz uwagę niżej.</div>';

    html += '<div class="gear-summary">' +
      '<div class="gs-row"><span>Aparat</span><b>' + rec.cam.name + '</b></div>' +
      '<div class="gs-row"><span>Obiektyw</span><b>' + rec.lens.name + '</b></div>' +
      '<div class="gs-row"><span>Ogniskowa efektywna</span><b>' + rec.effLabel + ' (odpow. 35mm)</b></div>' +
      '</div>';

    html += '<div class="cam-block" style="margin-top:10px;">' +
      '<div class="cb-row"><span>Przysłona</span><b>' + rec.apertureText + '</b></div>' +
      '<div class="cb-row"><span>Czas</span><b>' + rec.shutterText + '</b></div>' +
      '<div class="cb-row"><span>ISO</span><b>' + rec.iso + '</b></div>' +
      '<div class="cb-row"><span>Balans bieli</span><b>' + rec.wb + '</b></div>' +
      '<div class="cb-tip">💡 ' + rec.note + '</div>' +
      '</div>';

    if(!rec.suited){
      html += '<p class="note">Do sceny „' + rec.scenario.label + '” lepiej sprawdzi się obiektyw: ' + describeIdealTypes(rec.scenario) + '.</p>';
    }

    box.innerHTML = html;
  }

  function resetSimFromScenario(brand, camId, lensId, scenarioId){
    var g = GEAR[brand];
    var cam = findById(g.cameras, camId);
    var lens = findById(g.lenses, lensId);
    var scenario = findById(SCENARIOS, scenarioId);
    if(!cam || !lens || !scenario) return;

    var apertures = getAchievableApertures(lens);
    var targetAperture = scenario.useMaxAperture ? lens.maxAperture : Math.max(scenario.defAperture, lens.maxAperture);
    var apertureIdx = nearestIndexLog(apertures, targetAperture);

    var shutterIdx = nearestIndexLog(SHUTTER_STOPS, scenario.defShutterSec);
    var isoIdx = nearestIndexLog(ISO_STOPS, scenario.defISO);

    var minFocal = Math.round(lens.minF * cam.crop);
    var maxFocal = Math.round(lens.maxF * cam.crop);
    var focal;
    if(scenario.focalBias === 'tele') focal = maxFocal;
    else if(scenario.focalBias === 'wide') focal = minFocal;
    else focal = Math.round((minFocal + maxFocal) / 2);

    state.sim = {
      apertures: apertures, apertureIdx: apertureIdx,
      shutterIdx: shutterIdx, isoIdx: isoIdx,
      minFocal: minFocal, maxFocal: maxFocal, focal: focal,
      wb: scenario.defWB
    };
  }

  function buildCaption(apertureF, shutterSec, iso, wb, minFocal, maxFocal, focal){
    var parts = [];
    if(apertureF <= 2.8) parts.push('bardzo płytka głębia ostrości — tło mocno rozmyte');
    else if(apertureF <= 5.6) parts.push('umiarkowanie płytka głębia ostrości');
    else if(apertureF >= 11) parts.push('duża głębia ostrości — ostro od pierwszego planu po tło');
    else parts.push('średnia głębia ostrości');

    if(shutterSec >= 2) parts.push('długi czas otwarcia migawki rozjaśnia scenę i rozmywa ruch (statyw wskazany)');
    else if(shutterSec >= 1/15) parts.push('dłuższy czas otwarcia — możliwe lekkie rozmycie ruchu');
    else if(shutterSec <= 1/1000) parts.push('bardzo krótki czas — zamraża nawet szybki ruch');

    if(iso >= 3200) parts.push('wysokie ISO — wyraźnie widoczne ziarno/szum');
    else if(iso >= 800) parts.push('podniesione ISO — lekko widoczne ziarno');
    else parts.push('niskie ISO — czysty, mało zaszumiony obraz');

    if(wb <= 4200) parts.push('chłodny balans bieli — niebieskawy odcień');
    else if(wb >= 6500) parts.push('ciepły balans bieli — mocno pomarańczowy odcień');
    else parts.push('neutralny balans bieli');

    if(maxFocal > minFocal && focal / minFocal >= 1.8){
      parts.push('dłuższa ogniskowa „przybliża” kadr i spłaszcza perspektywę');
    }

    return parts.join('; ') + '.';
  }

  function updatePreview(){
    var sim = state.sim;
    if(!sim) return;

    var apertureF = sim.apertures[sim.apertureIdx];
    var shutterSec = SHUTTER_STOPS[sim.shutterIdx];
    var iso = ISO_STOPS[sim.isoIdx];
    var wb = sim.wb;
    var focal = sim.focal;

    if($('simApertureVal')) $('simApertureVal').textContent = 'f/' + apertureF;
    if($('simShutterVal')) $('simShutterVal').textContent = fmtShutter(shutterSec);
    if($('simISOVal')) $('simISOVal').textContent = 'ISO ' + iso;
    if($('simWBVal')) $('simWBVal').textContent = wb + ' K';
    if($('simFocalVal')) $('simFocalVal').textContent = focal + 'mm (odpow. 35mm)';

    // exposure (brightness) vs. neutral baseline f/8, 1/250s, ISO100
    var stopsAperture = 2 * (Math.log(8/apertureF) / Math.log(2));
    var stopsShutter = Math.log(shutterSec / (1/250)) / Math.log(2);
    var stopsISO = Math.log(iso/100) / Math.log(2);
    var totalStops = clamp(stopsAperture + stopsShutter + stopsISO, -6, 6);
    var brightness = clamp(Math.pow(2, totalStops * 0.28), 0.25, 2.4);
    var contrast = clamp(1 - Math.abs(totalStops) * 0.02, 0.75, 1);

    // depth of field blur (aperture + focal length)
    var apNorm = clamp((Math.log(apertureF) - Math.log(1)) / (Math.log(22) - Math.log(1)), 0, 1);
    var focalRange = Math.max(1, sim.maxFocal - sim.minFocal);
    var focalNorm = clamp((focal - sim.minFocal) / focalRange, 0, 1);
    var blurPx = clamp((1 - apNorm) * (0.5 + 0.5 * focalNorm) * 13, 0, 13);
    var focusRadius = clamp(22 + apNorm * 60, 20, 90);

    var blurLayer = $('previewBlurLayer');
    if(blurLayer){
      blurLayer.style.filter = 'blur(' + blurPx.toFixed(1) + 'px)';
      var maskCss = 'radial-gradient(ellipse at 50% 55%, transparent 0%, transparent ' +
        Math.max(0, focusRadius - 18) + '%, black ' + Math.min(100, focusRadius + 18) + '%)';
      blurLayer.style.webkitMaskImage = maskCss;
      blurLayer.style.maskImage = maskCss;
      blurLayer.style.opacity = blurPx > 0.3 ? 1 : 0;
    }

    // motion blur (shutter speed) via SVG filter
    var motionAmt = shutterSec >= 1 ? clamp((Math.log(shutterSec)/Math.log(2)) * 1.4, 0, 9) : 0;
    var stdDevEl = $('motionBlurStdDev');
    if(stdDevEl) stdDevEl.setAttribute('stdDeviation', motionAmt.toFixed(2) + ' 0');
    var img = $('previewImg');
    if(img) img.style.filter = motionAmt > 0.15 ? 'url(#motionBlurFilter)' : 'none';

    // ISO grain
    var isoIdxNorm = sim.isoIdx / (ISO_STOPS.length - 1);
    var grainLayer = $('previewGrain');
    if(grainLayer) grainLayer.style.opacity = (isoIdxNorm * 0.55).toFixed(2);

    // white balance tint
    var wbNorm = clamp((wb - 3000) / (10000 - 3000), 0, 1);
    var coolColor = [110,150,255], warmColor = [255,150,60];
    var mixed = [0,1,2].map(function(i){ return Math.round(coolColor[i] + (warmColor[i]-coolColor[i])*wbNorm); });
    var dist = Math.abs(wbNorm - 0.5) * 2;
    var alpha = (0.06 + dist * 0.32).toFixed(2);
    var tintLayer = $('previewTint');
    if(tintLayer) tintLayer.style.background = 'rgba(' + mixed.join(',') + ',' + alpha + ')';

    // zoom (focal length)
    var zoomScale = 1 + focalNorm * 0.85;
    var zoomEl = $('previewZoom');
    if(zoomEl) zoomEl.style.transform = 'scale(' + zoomScale.toFixed(2) + ')';

    var frame = $('previewFrame');
    if(frame) frame.style.filter = 'brightness(' + brightness.toFixed(2) + ') contrast(' + contrast.toFixed(2) + ')';

    var caption = $('previewCaption');
    if(caption) caption.textContent = capitalize(buildCaption(apertureF, shutterSec, iso, wb, sim.minFocal, sim.maxFocal, focal));
  }

  function renderGearCard(){
    var brand = state.cameraBrand === 'canon' ? 'canon' : 'nikon';
    var g = GEAR[brand];
    if(!state.gearCamera[brand]) state.gearCamera[brand] = g.cameras[0].id;
    if(!state.gearLens[brand]) state.gearLens[brand] = g.lenses[0].id;
    if(!state.gearScenario) state.gearScenario = SCENARIOS[0].id;

    var selCam = state.gearCamera[brand];
    var selLens = state.gearLens[brand];
    var selScenario = state.gearScenario;

    if(!state.sim) resetSimFromScenario(brand, selCam, selLens, selScenario);
    var sim = state.sim;

    var html = '<h2>🎯 Dobór obiektywu i ustawień</h2>';
    html += '<p class="note">Wybierz markę, model aparatu, obiektyw i scenę — dostaniesz gotowe ustawienia dopasowane do realnej ogniskowej Twojego sprzętu.</p>';
    html += '<div class="brand-toggle">' +
      '<button type="button" class="brand-btn' + (brand==='nikon'?' active':'') + '" data-brand="nikon">Nikon</button>' +
      '<button type="button" class="brand-btn' + (brand==='canon'?' active':'') + '" data-brand="canon">Canon</button>' +
      '</div>';

    html += '<label class="gear-label" for="gearCameraSel">Aparat</label>';
    html += '<select id="gearCameraSel" class="gear-select">' + g.cameras.map(function(c){
      return '<option value="' + c.id + '"' + (c.id===selCam?' selected':'') + '>' + c.name + ' — ' + c.sensor + '</option>';
    }).join('') + '</select>';

    html += '<label class="gear-label" for="gearLensSel">Obiektyw</label>';
    html += '<select id="gearLensSel" class="gear-select">' + g.lenses.map(function(l){
      return '<option value="' + l.id + '"' + (l.id===selLens?' selected':'') + '>' + l.name + '</option>';
    }).join('') + '</select>';

    html += '<label class="gear-label" for="gearScenarioSel">Warunki / rodzaj fotografii</label>';
    html += '<select id="gearScenarioSel" class="gear-select">' + SCENARIOS.map(function(s){
      return '<option value="' + s.id + '"' + (s.id===selScenario?' selected':'') + '>' + s.label + '</option>';
    }).join('') + '</select>';

    html += '<div id="gearResult"></div>';

    html += '<div class="preview-section">';
    html += '<h3 class="preview-title">🖼️ Podgląd na żywo — jak ustawienia wpływają na zdjęcie</h3>';
    html += '<div class="preview-frame" id="previewFrame">' +
      '<div class="preview-zoom" id="previewZoom">' +
        '<img src="' + PHOTO_URL + '" alt="Pole zbóż o złotej godzinie" class="preview-img" id="previewImg"/>' +
        '<div class="preview-layer" id="previewBlurLayer" style="background-image:url(\'' + PHOTO_URL + '\');"></div>' +
      '</div>' +
      '<div class="preview-overlay" id="previewGrain"></div>' +
      '<div class="preview-overlay" id="previewTint"></div>' +
      '</div>';
    html += '<p class="photo-credit">' + PHOTO_CREDIT_HTML + '</p>';
    html += '<p class="note" id="previewCaption"></p>';

    html += '<div class="gear-range-row"><label for="simFocal">Ogniskowa <b id="simFocalVal">—</b></label>' +
      '<input type="range" class="gear-range" id="simFocal" min="' + sim.minFocal + '" max="' + sim.maxFocal + '" step="1" value="' + sim.focal + '"' + (sim.minFocal===sim.maxFocal?' disabled':'') + '/></div>';
    html += '<div class="gear-range-row"><label for="simAperture">Przysłona <b id="simApertureVal">—</b></label>' +
      '<input type="range" class="gear-range" id="simAperture" min="0" max="' + (sim.apertures.length-1) + '" step="1" value="' + sim.apertureIdx + '"/></div>';
    html += '<div class="gear-range-row"><label for="simShutter">Czas otwarcia migawki <b id="simShutterVal">—</b></label>' +
      '<input type="range" class="gear-range" id="simShutter" min="0" max="' + (SHUTTER_STOPS.length-1) + '" step="1" value="' + sim.shutterIdx + '"/></div>';
    html += '<div class="gear-range-row"><label for="simISO">ISO <b id="simISOVal">—</b></label>' +
      '<input type="range" class="gear-range" id="simISO" min="0" max="' + (ISO_STOPS.length-1) + '" step="1" value="' + sim.isoIdx + '"/></div>';
    html += '<div class="gear-range-row"><label for="simWB">Balans bieli <b id="simWBVal">—</b></label>' +
      '<input type="range" class="gear-range" id="simWB" min="3000" max="10000" step="100" value="' + sim.wb + '"/></div>';
    html += '<button type="button" class="secondary" id="simResetBtn">↺ Przywróć ustawienia dla tej sceny</button>';
    html += '</div>';

    $('gearCard').innerHTML = html;
    renderGearResult(computeGearRecommendation(brand, selCam, selLens, selScenario));
    updatePreview();

    Array.prototype.forEach.call(document.querySelectorAll('#gearCard .brand-btn'), function(btn){
      btn.addEventListener('click', function(){ state.sim = null; setCameraBrand(btn.getAttribute('data-brand')); });
    });
    $('gearCameraSel').addEventListener('change', function(){
      state.gearCamera[brand] = this.value;
      state.sim = null;
      renderGearCard();
    });
    $('gearLensSel').addEventListener('change', function(){
      state.gearLens[brand] = this.value;
      state.sim = null;
      renderGearCard();
    });
    $('gearScenarioSel').addEventListener('change', function(){
      state.gearScenario = this.value;
      state.sim = null;
      renderGearCard();
    });

    $('simFocal').addEventListener('input', function(){ state.sim.focal = parseInt(this.value, 10); updatePreview(); });
    $('simAperture').addEventListener('input', function(){ state.sim.apertureIdx = parseInt(this.value, 10); updatePreview(); });
    $('simShutter').addEventListener('input', function(){ state.sim.shutterIdx = parseInt(this.value, 10); updatePreview(); });
    $('simISO').addEventListener('input', function(){ state.sim.isoIdx = parseInt(this.value, 10); updatePreview(); });
    $('simWB').addEventListener('input', function(){ state.sim.wb = parseInt(this.value, 10); updatePreview(); });
    $('simResetBtn').addEventListener('click', function(){ state.sim = null; renderGearCard(); });
  }

  // ---------------- tabs ----------------
  function showTab(which){
    var isDay = which === 'day';
    $('tabDayPanel').classList.toggle('hidden', !isDay);
    $('tabGearPanel').classList.toggle('hidden', isDay);
    $('tabBtnDay').classList.toggle('active', isDay);
    $('tabBtnGear').classList.toggle('active', !isDay);
    if(!isDay) renderGearCard();
  }
  $('tabBtnDay').addEventListener('click', function(){ showTab('day'); });
  $('tabBtnGear').addEventListener('click', function(){ showTab('gear'); });

  var TIMELINE_KEYS = [
    ['nightEnd', '#0a0e2a'],
    ['nauticalDawn', '#16204a'],
    ['blueHourDawnStart', '#1f3a72'],
    ['dawn', '#3a5a9c'],
    ['blueHourDawnEnd', '#5b7fd4'],
    ['sunrise', '#f4a94a'],
    ['goldenHourEnd', '#fff3d6'],
    ['solarNoon', '#cfe8ff'],
    ['goldenHour', '#fff3d6'],
    ['sunset', '#f4a94a'],
    ['blueHourDuskStart', '#5b7fd4'],
    ['dusk', '#3a5a9c'],
    ['blueHourDuskEnd', '#1f3a72'],
    ['nauticalDusk', '#16204a'],
    ['night', '#0a0e2a']
  ];

  function renderTimeline(times, timesNext){
    var rangeStart = times.nightEnd || times.nauticalDawn || times.dawn || times.sunrise;
    var rangeEnd = times.night || times.nauticalDusk || times.dusk || times.sunset;
    var html = '<h2>☀️ Szczegółowy rozkład dnia <span class="muted">' + (isValidDate(times.sunrise)&&isValidDate(times.sunset) ? '' : 'okolice bieguna') + '</span></h2>';

    if(isValidDate(rangeStart) && isValidDate(rangeEnd) && rangeEnd > rangeStart){
      var stops = [];
      TIMELINE_KEYS.forEach(function(pair){
        var t = times[pair[0]];
        if(isValidDate(t)){
          var pct = (t - rangeStart) / (rangeEnd - rangeStart) * 100;
          pct = Math.max(0, Math.min(100, pct));
          stops.push(pct + '% ' + pair[1]);
        }
      });
      var gradient = 'linear-gradient(to right, ' + stops.join(', ') + ')';
      html += '<div class="timeline-bar" style="background:' + gradient + '">';
      var now = new Date();
      if(localDayKey(now) === localDayKey(times.solarNoon || now) && now >= rangeStart && now <= rangeEnd){
        var nowPct = (now - rangeStart) / (rangeEnd - rangeStart) * 100;
        html += '<div class="timeline-now" style="left:' + nowPct + '%"></div>';
      }
      html += '</div>';
    } else {
      html += '<p class="note">O tej porze roku w tej lokalizacji niektóre fazy zmierzchu mogą nie występować (białe noce lub noc polarna) — poniższe godziny mogą być niepełne.</p>';
    }

    function evt(key, label){
      var t = times[key];
      if(!isValidDate(t)) return '';
      return '<div class="event-item"><span class="label">' + label + '</span><span class="time">' + fmtTime(t) + '</span></div>';
    }

    html += '<div class="events-group"><h3>Poranek</h3>' +
      evt('nightEnd','Koniec nocy astronomicznej') +
      evt('nauticalDawn','Świt żeglarski') +
      evt('blueHourDawnStart','🔵 Niebieska godzina — początek') +
      evt('dawn','✨ Świt cywilny (idealny moment niebieskiej godz.)') +
      evt('blueHourDawnEnd','🔵 Niebieska godzina — koniec') +
      evt('sunrise','🌅 Wschód słońca') +
      evt('goldenHourPeakMorning','✨ Złota godzina — idealny moment') +
      evt('goldenHourEnd','🟡 Złota godzina (rano) — koniec') +
      '</div>';

    html += '<div class="events-group"><h3>Środek dnia</h3>' +
      evt('solarNoon','☀️ Południe słoneczne') +
      '</div>';

    html += '<div class="events-group"><h3>Wieczór</h3>' +
      evt('goldenHour','🟡 Złota godzina (wieczór) — początek') +
      evt('goldenHourPeakEvening','✨ Złota godzina — idealny moment') +
      evt('sunset','🌇 Zachód słońca') +
      evt('blueHourDuskStart','🔵 Niebieska godzina — początek') +
      evt('dusk','✨ Zmierzch cywilny (idealny moment niebieskiej godz.)') +
      evt('blueHourDuskEnd','🔵 Niebieska godzina — koniec') +
      evt('nauticalDusk','Zmierzch żeglarski') +
      evt('night','Początek nocy astronomicznej') +
      '</div>';

    $('timelineCard').innerHTML = html;
  }

  function renderDayLength(times, timesPrev){
    if(!isValidDate(times.sunrise) || !isValidDate(times.sunset)) return;
    var len = (times.sunset - times.sunrise) / 60000;
    var h = Math.floor(len/60), m = Math.round(len%60);
    var lenStr = h + ' godz ' + m + ' min';
    var delta = '';
    if(isValidDate(timesPrev.sunrise) && isValidDate(timesPrev.sunset)){
      var lenPrev = (timesPrev.sunset - timesPrev.sunrise) / 60000;
      var diff = Math.round(len - lenPrev);
      if(diff > 0) delta = '+' + diff + ' min dnia względem wczoraj';
      else if(diff < 0) delta = diff + ' min dnia względem wczoraj';
      else delta = 'tyle samo co wczoraj';
    }
    var pos = SunCalc.getPosition(times.solarNoon, state.lat, state.lon);
    var maxAlt = Math.round(pos.altitude * 180/Math.PI);
    var extra = '<div class="stat-grid">' +
      '<div class="stat-box"><div class="val">' + lenStr + '</div><div class="lbl">Długość dnia</div></div>' +
      '<div class="stat-box"><div class="val">' + delta + '</div><div class="lbl">Zmiana dnia</div></div>' +
      '<div class="stat-box"><div class="val">' + maxAlt + '°</div><div class="lbl">Maks. wysokość słońca</div></div>' +
      '<div class="stat-box"><div class="val">' + (maxAlt > 50 ? 'Ostre cienie w południe' : 'Łagodniejsze światło') + '</div><div class="lbl">Charakter światła</div></div>' +
      '</div>';
    $('timelineCard').innerHTML += extra;
  }

  function renderMoon(dateNoon, moonIllum, moonTimes){
    var info = moonPhaseInfo(moonIllum.phase);
    var events = findNextMoonEvents(dateNoon);
    var html = '<h2>🌙 Księżyc</h2>';
    html += '<div class="moon-row"><div class="moon-icon">' + info.icon + '</div><div class="moon-info">' +
      '<div class="name">' + info.name + '</div>' +
      '<div class="illum">Oświetlenie tarczy: ' + Math.round(moonIllum.fraction*100) + '%</div>' +
      '</div></div>';

    html += '<div class="events-group"><h3>Ten dzień</h3>';
    if(moonTimes.alwaysUp) html += '<div class="event-item"><span class="label">Księżyc</span><span class="time">cały czas nad horyzontem</span></div>';
    else if(moonTimes.alwaysDown) html += '<div class="event-item"><span class="label">Księżyc</span><span class="time">cały czas pod horyzontem</span></div>';
    else {
      if(isValidDate(moonTimes.rise)) html += '<div class="event-item"><span class="label">Wschód Księżyca</span><span class="time">' + fmtTime(moonTimes.rise) + '</span></div>';
      if(isValidDate(moonTimes.set)) html += '<div class="event-item"><span class="label">Zachód Księżyca</span><span class="time">' + fmtTime(moonTimes.set) + '</span></div>';
    }
    html += '</div>';

    html += '<div class="events-group"><h3>Najbliższe fazy</h3>';
    if(events.nextFull) html += '<div class="event-item"><span class="label">🌕 Następna pełnia</span><span class="time">' + fmtDateShort(events.nextFull) + '</span></div>';
    if(events.nextNew) html += '<div class="event-item"><span class="label">🌑 Następny nów</span><span class="time">' + fmtDateShort(events.nextNew) + '</span></div>';
    html += '</div>';

    var illumPct = Math.round(moonIllum.fraction*100);
    var moonNote = illumPct >= 40
      ? 'Jasny Księżyc (' + illumPct + '%) mocno ograniczy widoczność gwiazd i Drogi Mlecznej — sprawdź okna bez Księżyca w sekcji „Niebo nocne” poniżej.'
      : 'Niska jasność Księżyca (' + illumPct + '%) — dobre warunki na gwiazdy i Drogę Mleczną, zwłaszcza w oknach bez Księżyca opisanych w sekcji „Niebo nocne” poniżej.';
    html += '<p class="note">' + moonNote + '</p>';

    $('moonCard').innerHTML = html;
  }

  function renderWeather(times){
    var html = '<h2>🌤️ Pogoda i warunki świetlne</h2>';
    if(!state.weather || !state.weather.hourly){
      html += '<p class="note">Prognoza pogody niedostępna (brak połączenia lub przekroczony zasięg prognozy — Open-Meteo udostępnia ok. 16 dni do przodu).</p>';
      $('weatherCard').innerHTML = html;
      return;
    }
    var dayKey = localDayKey(times.solarNoon || new Date());
    var firstKey = state.weather.hourly.time[0] ? state.weather.hourly.time[0].slice(0,10) : null;
    var lastKey = state.weather.hourly.time.length ? state.weather.hourly.time[state.weather.hourly.time.length-1].slice(0,10) : null;
    if(firstKey && (dayKey < firstKey || dayKey > lastKey)){
      html += '<p class="note">Wybrana data jest poza zasięgiem prognozy (Open-Meteo prognozuje ok. 16 dni do przodu). Poniżej tylko obliczenia astronomiczne.</p>';
      $('weatherCard').innerHTML = html;
      return;
    }

    var cloudMorningGolden = isValidDate(times.sunrise) ? cloudAt(times.sunrise) : null;
    var cloudEveningGolden = isValidDate(times.goldenHour) ? cloudAt(times.goldenHour) : null;
    var cloudSunset = isValidDate(times.sunset) ? cloudAt(times.sunset) : null;
    var avg = dayAvgCloud(dayKey);

    var score = conditionsScore(cloudSunset != null ? cloudSunset : avg);
    if(score){
      html += '<div class="weather-score"><div class="emoji">' + score.emoji + '</div><div><div class="label">' + score.label + '</div><div class="desc">' + score.desc + '</div></div></div>';
    }

    html += '<div class="stat-grid">';
    html += '<div class="stat-box"><div class="val">' + (cloudMorningGolden!=null? cloudMorningGolden+'%' : '—') + '</div><div class="lbl">Zachmurzenie o wschodzie</div></div>';
    html += '<div class="stat-box"><div class="val">' + (cloudSunset!=null? cloudSunset+'%' : '—') + '</div><div class="lbl">Zachmurzenie o zachodzie</div></div>';
    html += '<div class="stat-box"><div class="val">' + (avg!=null? avg+'%' : '—') + '</div><div class="lbl">Śr. zachmurzenie w ciągu dnia</div></div>';
    var idxNow = state.weather.hourly.time.indexOf(nearestHourKey(times.solarNoon || new Date()));
    var vis = idxNow !== -1 && state.weather.hourly.visibility ? state.weather.hourly.visibility[idxNow] : null;
    html += '<div class="stat-box"><div class="val">' + (vis!=null ? Math.round(vis/1000)+' km' : '—') + '</div><div class="lbl">Widzialność (ok. południa)</div></div>';
    html += '</div>';

    // mini bar chart for daylight hours
    var hours = [], clouds = [];
    state.weather.hourly.time.forEach(function(t, i){
      if(t.indexOf(dayKey) === 0){
        var h = parseInt(t.slice(11,13),10);
        if(h % 2 === 0 && h >= 4 && h <= 22){
          hours.push(h);
          clouds.push(state.weather.hourly.cloudcover[i]);
        }
      }
    });
    if(hours.length){
      html += '<div class="bar-chart">';
      hours.forEach(function(h,i){
        html += '<div class="bar"><div class="fill" style="height:' + Math.max(3,clouds[i]) + '%"></div><div class="hr">' + h + '</div></div>';
      });
      html += '</div><p class="note">Zachmurzenie (%) co 2 godziny w wybranym dniu.</p>';
    }

    $('weatherCard').innerHTML = html;
  }

  function renderDarkSky(times, timesNext){
    var html = '<h2>🌌 Niebo nocne / astrofotografia</h2>';
    var start = times.night, end = timesNext.nightEnd;
    if(!isValidDate(start) || !isValidDate(end) || end <= start){
      html += '<p class="note">W tej lokalizacji i porze roku noc astronomiczna może nie występować (białe noce) — trudne warunki na gwiazdy/Drogę Mleczną.</p>';
      $('darkskyCard').innerHTML = html;
      return;
    }
    html += '<p class="note">Okno pełnej ciemności (noc astronomiczna): <b>' + fmtTime(start) + ' – ' + fmtTime(end) + '</b></p>';

    // sample moon altitude every 15 min across the dark window
    var stepMs = 15*60000;
    var windows = [];
    var curStart = null;
    for(var t = start.getTime(); t <= end.getTime(); t += stepMs){
      var d = new Date(t);
      var pos = SunCalc.getMoonPosition(d, state.lat, state.lon);
      var below = pos.altitude < 0;
      if(below && curStart === null) curStart = d;
      if(!below && curStart !== null){ windows.push([curStart, d]); curStart = null; }
    }
    if(curStart !== null) windows.push([curStart, end]);

    if(windows.length){
      html += '<p class="note">Okna bez zakłóceń od Księżyca (najlepsze na gwiazdy i Drogę Mleczną):</p>';
      windows.forEach(function(w){
        html += '<div class="dark-window"><span>Bez Księżyca</span><span class="rng">' + fmtTime(w[0]) + ' – ' + fmtTime(w[1]) + '</span></div>';
      });
    } else {
      html += '<p class="note">Księżyc będzie nad horyzontem przez całe okno ciemności — ograniczona widoczność słabych obiektów i Drogi Mlecznej tej nocy.</p>';
    }

    $('darkskyCard').innerHTML = html;
  }

  function renderMap(times, moonTimes, moonIllum){
    if(!state.map){
      state.map = L.map('mapEl', {zoomControl:true, attributionControl:true});
      state.mapLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 19
      }).addTo(state.map);
    } else {
      state.map.eachLayer(function(l){ if(!(l instanceof L.TileLayer)) state.map.removeLayer(l); });
    }
    state.map.setView([state.lat, state.lon], 12);
    L.marker([state.lat, state.lon]).addTo(state.map);

    var lines = [];
    function addLine(fromTime, color, label, distKm){
      if(!isValidDate(fromTime)) return;
      var pos = SunCalc.getPosition(fromTime, state.lat, state.lon);
      var bearing = bearingFromAzimuth(pos.azimuth);
      var dest = destinationPoint(state.lat, state.lon, bearing, distKm || 2.5);
      var line = L.polyline([[state.lat, state.lon], dest], {color: color, weight: 3, opacity: .85, dashArray: label.indexOf('Księżyc')!==-1 ? '6,5' : null}).addTo(state.map);
      lines.push(line);
    }
    function addMoonLine(moonTime, color, distKm){
      if(!isValidDate(moonTime)) return;
      var pos = SunCalc.getMoonPosition(moonTime, state.lat, state.lon);
      var bearing = bearingFromAzimuth(pos.azimuth);
      var dest = destinationPoint(state.lat, state.lon, bearing, distKm || 2.5);
      var line = L.polyline([[state.lat, state.lon], dest], {color: color, weight: 3, opacity: .85, dashArray: '6,5'}).addTo(state.map);
      lines.push(line);
    }

    addLine(times.sunrise, '#f4a94a', 'Wschód słońca', 2.5);
    addLine(times.sunset, '#d9678c', 'Zachód słońca', 2.5);
    if(moonTimes && !moonTimes.alwaysUp && !moonTimes.alwaysDown){
      addMoonLine(moonTimes.rise, '#8fb8ff', 2.2);
      addMoonLine(moonTimes.set, '#5b7fd4', 2.2);
    }

    var legend = '';
    if(isValidDate(times.sunrise)){
      var az1 = bearingFromAzimuth(SunCalc.getPosition(times.sunrise, state.lat, state.lon).azimuth);
      legend += '<span><i style="background:#f4a94a"></i>Wschód słońca: ' + Math.round(az1) + '° (' + compassLabel(az1) + ')</span>';
    }
    if(isValidDate(times.sunset)){
      var az2 = bearingFromAzimuth(SunCalc.getPosition(times.sunset, state.lat, state.lon).azimuth);
      legend += '<span><i style="background:#d9678c"></i>Zachód słońca: ' + Math.round(az2) + '° (' + compassLabel(az2) + ')</span>';
    }
    if(moonTimes && isValidDate(moonTimes.rise)){
      var az3 = bearingFromAzimuth(SunCalc.getMoonPosition(moonTimes.rise, state.lat, state.lon).azimuth);
      legend += '<span><i style="background:#8fb8ff"></i>Wschód Księżyca: ' + Math.round(az3) + '° (' + compassLabel(az3) + ')</span>';
    }
    if(moonTimes && isValidDate(moonTimes.set)){
      var az4 = bearingFromAzimuth(SunCalc.getMoonPosition(moonTimes.set, state.lat, state.lon).azimuth);
      legend += '<span><i style="background:#5b7fd4"></i>Zachód Księżyca: ' + Math.round(az4) + '° (' + compassLabel(az4) + ')</span>';
    }
    $('mapLegend').innerHTML = legend;

    setTimeout(function(){ state.map.invalidateSize(); }, 150);
  }

  var calendarDays = 7;
  function renderCalendar(dp){
    var html = '<h2>📅 Nadchodzące dni <span class="muted">planowanie sesji</span></h2>';
    for(var i=0;i<calendarDays;i++){
      var noon = noonUTCFor(dp.y, dp.m, dp.d + i);
      var t = SunCalc.getTimes(noon, state.lat, state.lon);
      var dayKey = localDayKey(noon);
      var avgCloud = dayAvgCloud(dayKey);
      var cloudLabel = avgCloud != null ? avgCloud + '%' : '—';
      var sc = conditionsScore(avgCloud);
      html += '<div class="day-card">' +
        '<div class="d-date">' + capitalize(fmtWeekday(noon)) + '<small>' + fmtDateShort(noon) + '</small></div>' +
        '<div class="d-times">🟡 rano <b>' + fmtTime(t.sunrise) + '–' + fmtTime(t.goldenHourEnd) + '</b><br/>🟡 wiecz. <b>' + fmtTime(t.goldenHour) + '–' + fmtTime(t.sunset) + '</b></div>' +
        '<div class="d-cloud">' + (sc ? sc.emoji : '') + ' ' + cloudLabel + '</div>' +
        '</div>';
    }
    if(calendarDays < 14){
      html += '<button class="secondary" id="moreDaysBtn" type="button" style="width:100%;margin-top:4px;">Pokaż więcej dni</button>';
    }
    $('calendarCard').innerHTML = html;
    var btn = $('moreDaysBtn');
    if(btn) btn.addEventListener('click', function(){
      calendarDays = 14;
      var dp2 = parseYMD($('dateInput').value);
      renderCalendar(dp2);
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function capitalize(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  // ---------------- init: default to a sensible location (Łódź) ----------------
  renderFavChips();
  setLocation(51.7592, 19.4560, 'Łódź', 'łódzkie, Polska');
  $('placeInput').value = '';

})();
