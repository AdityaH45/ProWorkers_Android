import React, { useState, useEffect, useRef, useMemo } from "react";
import { LanguageProvider, useLang, LANGUAGES } from "./i18n.jsx";
import { QRCodeSVG } from "qrcode.react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { LocalNotifications } from "@capacitor/local-notifications";
import { PushNotifications } from "@capacitor/push-notifications";

// ── Password field with a show / hide (eye) button ───────────────────────────
// Drop-in replacement for <input type="password">. Pass the same style / value /
// onChange / placeholder props. Use wrapStyle for outer spacing (e.g. marginBottom).
function PasswordInput({ style, wrapStyle, ...props }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position:"relative", ...wrapStyle }}>
      <input {...props} type={show ? "text" : "password"} style={{ ...style, paddingRight:48 }}/>
      <button
        type="button"
        aria-label={show ? "Hide password" : "Show password"}
        onMouseDown={e => e.preventDefault()}
        onClick={() => setShow(s => !s)}
        style={{ position:"absolute", right:6, top:"50%", transform:"translateY(-50%)", width:38, height:38,
                 display:"flex", alignItems:"center", justifyContent:"center", background:"none", border:"none",
                 color:"#8B949E", cursor:"pointer", padding:0 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {show ? (
            <>
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </>
          ) : (
            <>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </>
          )}
        </svg>
      </button>
    </div>
  );
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function useTheme() {
  const [dark, setDark] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)").matches : true
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = (e) => setDark(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return dark;
}

function makeC(dark) {
  return dark ? {
    bg:"#0D1117", card:"#161B22", card2:"#1C2333", border:"#21262D",
    text:"#E6EDF3", muted:"#6E7681", sub:"#8B949E",
    amber:"#F0A500", blue:"#388BFD", green:"#3FB950", red:"#F85149",
  } : {
    bg:"#F6F8FA", card:"#FFFFFF", card2:"#F0F2F5", border:"#D0D7DE",
    text:"#1F2328", muted:"#848D97", sub:"#656C76",
    amber:"#BF8700", blue:"#0969DA", green:"#1A7F37", red:"#CF222E",
  };
}

// ── Workers Data ──────────────────────────────────────────────────────────────
// NOTE: Workers are real accounts stored in MongoDB. There is no fake/demo
// worker list here — availability is always checked against the live backend
// (see /api/workers/counts and /api/workers/check/:type).

// Trial jobs (₹1) carry no platform fee for the customer or the worker.
const TRIAL_JOB_IDS = ["ej0", "pj0", "lj0"];
const CASH_CHARGE = 10;   // extra platform charge when the customer pays cash
const cashChargeFor = b => ((b.items||[]).length && (b.items||[]).every(i => TRIAL_JOB_IDS.includes(i.id))) ? 0 : CASH_CHARGE;

// What the customer pays ProWorkers on top of the service: ₹0 below ₹400, ₹10 up to ₹1000, ₹20 above.
// (The server works this out too and has the final say.)
const customerFeeFor = t => (Number(t) || 0) < 400 ? 0 : ((Number(t) || 0) <= 1000 ? 10 : 20);

const SERVICES = {
  electrician: { label:"Electrician",      icon:"⚡", color:"#F0A500",
    jobs:[{id:"ej1",name:"Fan Installation",price:200},{id:"ej2",name:"Light / Switch Repair",price:120},{id:"ej3",name:"MCB Panel Work",price:450},{id:"ej4",name:"Wiring (per room)",price:800},{id:"ej5",name:"Inverter / UPS Setup",price:350},{id:"ej6",name:"Meter Connection",price:250},{id:"ej7",name:"AC Electrical Point",price:300},{id:"ej8",name:"Earthing Work",price:400}] },
  plumber:     { label:"Plumber",          icon:"🔧", color:"#388BFD",
    jobs:[{id:"pj1",name:"Pipe Repair / Leak Fix",price:180},{id:"pj2",name:"Tap / Faucet Replace",price:150},{id:"pj3",name:"Bathroom Fitting",price:600},{id:"pj4",name:"Water Tank Cleaning",price:400},{id:"pj5",name:"Drainage Unclogging",price:220},{id:"pj6",name:"Geyser Installation",price:300},{id:"pj7",name:"Pipeline Extension",price:500},{id:"pj8",name:"Motor Pump Work",price:350}] },
  labour:      { label:"Labour / Man Work",icon:"🏗️",color:"#3FB950",
    jobs:[{id:"lj1",name:"Heavy Lifting / Shifting",price:100,unit:"hr"},{id:"lj2",name:"Wall Painting",price:100,unit:"hr"},{id:"lj3",name:"Tile / Floor Work",price:100,unit:"hr"},{id:"lj4",name:"Civil / Construction",price:100,unit:"hr"},{id:"lj5",name:"Deep Cleaning",price:100,unit:"hr"},{id:"lj6",name:"Furniture Assembly",price:100,unit:"hr"},{id:"lj7",name:"Demolition Work",price:100,unit:"hr"},{id:"lj8",name:"Garden / Outdoor Work",price:100,unit:"hr"}] },
};

// How many of an item: "2 hr" for hourly work (Labour), "×2" for everything else.
const qtyText = i => i.unit === "hr" ? `${i.qty || 1} hr × ₹${i.price}` : ((i.qty || 1) > 1 ? `×${i.qty}` : "");
const itemLabel = i => `${i.name}${i.unit === "hr" ? ` (${i.qty || 1} hr)` : ((i.qty || 1) > 1 ? ` ×${i.qty}` : "")}`;

// ── Tiny UI helpers ───────────────────────────────────────────────────────────
function inp(C) {
  return { width:"100%", padding:"13px 16px", background:C.card2, border:`1.5px solid ${C.border}`, borderRadius:12, color:C.text, fontSize:15, outline:"none", boxSizing:"border-box", fontFamily:"inherit" };
}

function TrustRing({ trust, size = 48, color }) {
  const r = (size - 7) / 2, circ = 2 * Math.PI * r, dash = (trust / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform:"rotate(-90deg)", flexShrink:0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#21262D" strokeWidth={5}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={5} strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"/>
      <text x={size/2} y={size/2+5} textAnchor="middle" fontSize={11} fontWeight="800" fill={color} style={{ transformOrigin:`${size/2}px ${size/2}px`, transform:"rotate(90deg)", fontFamily:"system-ui" }}>{trust}</text>
    </svg>
  );
}

function Stars({ n, C, size = 14 }) {
  return (
    <span style={{ color:C.amber, fontSize:size }}>
      {"★".repeat(Math.round(n))}{"☆".repeat(5-Math.round(n))}
      <span style={{ color:C.muted, marginLeft:3, fontSize:size-2 }}>{n}</span>
    </span>
  );
}

function Av({ initials, color, size = 44, photo }) {
  if (photo) {
    return (
      <div style={{ width:size, height:size, borderRadius:"50%", flexShrink:0, overflow:"hidden", border:`2px solid ${color}` }}>
        <img src={photo} alt="avatar" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
      </div>
    );
  }
  return (
    <div style={{ width:size, height:size, borderRadius:"50%", flexShrink:0, background:`${color}20`, border:`2px solid ${color}`, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, color, fontSize:size*0.3 }}>
      {initials}
    </div>
  );
}

function Toast({ msg, color, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  return (
    <div style={{ position:"fixed", bottom:90, left:"50%", transform:"translateX(-50%)", background:color||"#3FB950", color:"#fff", padding:"12px 24px", borderRadius:14, fontWeight:700, fontSize:14, zIndex:999, boxShadow:"0 4px 24px #0008", whiteSpace:"nowrap" }}>
      {msg}
    </div>
  );
}

function Logo({ size = 22 }) {
  return (
    <span style={{ display:"flex", alignItems:"center", gap:8, fontWeight:900, fontSize:size, letterSpacing:-0.5 }}>
      <img src="/logo.jpg" alt="ProWorkers" style={{ height:size*1.5, width:"auto", borderRadius:6, objectFit:"contain" }}/>
      <span style={{ color:"#F0A500" }}>Pro</span><span style={{ color:"#E6EDF3" }}>Workers</span>
    </span>
  );
}

// ── Inline Star Picker (used in booking detail & post-payment) ────────────────
function InlineRating({ C, svc, workerName, workerAvatar, onSubmit, compact }) {
  const [stars,   setStars]   = useState(0);
  const [hover,   setHover]   = useState(0);
  const [remark,  setRemark]  = useState("");
  const [tags,    setTags]    = useState([]);
  const [done,    setDone]    = useState(false);

  const GOOD = ["On time","Clean work","Friendly","Fair price","Professional","Quick"];
  const BAD  = ["Late","Messy","Rude","Overcharged","Slow","Careless"];
  const LABELS = ["","Poor 😞","Average 😐","Good 🙂","Very Good 😊","Excellent 🌟"];

  const [submitting, setSubmitting] = useState(false);

  function toggle(t) { setTags(p => p.includes(t) ? p.filter(x=>x!==t) : [...p,t]); }

  // Previously this called setDone(true) immediately and fired onSubmit without
  // waiting — so if the API call actually failed (network issue, server error),
  // the UI still showed "Thank you for your rating!" even though nothing was
  // saved. Now we wait for onSubmit to resolve and only show success if it
  // didn't explicitly report failure (returning `false`).
  async function submit() {
    setSubmitting(true);
    const result = await onSubmit({ stars, tags, remark });
    setSubmitting(false);
    if (result !== false) setDone(true);
  }

  if (done) {
    return (
      <div style={{ textAlign:"center", padding:"20px 0" }}>
        <div style={{ fontSize:40 }}>🌟</div>
        <div style={{ color:C.green, fontWeight:800, fontSize:16, marginTop:8 }}>Thank you for your rating!</div>
      </div>
    );
  }

  return (
    <div>
      {!compact && (
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:18 }}>
          <Av initials={workerAvatar} color={svc.color} size={48} />
          <div>
            <div style={{ color:C.text, fontWeight:800, fontSize:15 }}>{workerName}</div>
            <div style={{ color:C.muted, fontSize:12 }}>{svc.icon} {svc.label}</div>
          </div>
        </div>
      )}

      <div style={{ color:C.text, fontWeight:700, fontSize:14, marginBottom:10 }}>Rate your experience</div>

      {/* Stars */}
      <div style={{ display:"flex", gap:6, marginBottom:6 }}>
        {[1,2,3,4,5].map(s => (
          <span key={s}
            onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(0)}
            onClick={() => setStars(s)}
            style={{ fontSize:34, cursor:"pointer", userSelect:"none", transition:"transform 0.1s",
              color:(hover||stars)>=s ? C.amber : C.border,
              transform:(hover||stars)>=s ? "scale(1.2)" : "scale(1)", display:"inline-block" }}>★</span>
        ))}
      </div>
      <div style={{ color:C.amber, fontWeight:600, fontSize:13, marginBottom:14, minHeight:18 }}>
        {LABELS[stars]}
      </div>

      {/* Tags */}
      {stars > 0 && (
        <div style={{ marginBottom:14 }}>
          <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:8 }}>
            {stars >= 4 ? "WHAT WENT WELL?" : "WHAT WENT WRONG?"}
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {(stars >= 4 ? GOOD : BAD).map(t => (
              <button key={t} onClick={() => toggle(t)} style={{
                padding:"6px 12px", borderRadius:20, fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit",
                border:`1.5px solid ${tags.includes(t) ? svc.color : C.border}`,
                background: tags.includes(t) ? `${svc.color}18` : C.card2,
                color: tags.includes(t) ? svc.color : C.sub,
              }}>{t}</button>
            ))}
          </div>
        </div>
      )}

      {/* Remark */}
      <div style={{ marginBottom:14 }}>
        <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:6 }}>REMARK (optional)</div>
        <textarea style={{ ...inp(C), minHeight:70, resize:"vertical", fontSize:13 }}
          placeholder="Write your experience or suggestion…"
          value={remark} onChange={e => setRemark(e.target.value)} />
      </div>

      <button onClick={submit} disabled={stars === 0 || submitting} style={{
        width:"100%", padding:"13px 0",
        background: stars > 0 ? svc.color : C.border,
        color: stars > 0 ? "#0D1117" : C.muted,
        border:"none", borderRadius:12, fontWeight:800, fontSize:15,
        cursor: (stars > 0 && !submitting) ? "pointer" : "not-allowed", opacity: submitting?0.7:1, fontFamily:"inherit",
      }}>
        {submitting ? "Saving…" : "Submit Rating & Remark"}
      </button>
    </div>
  );
}

// ── Full Map Screen (Leaflet + Mappls / OpenStreetMap) ───────────────────────
// Map keys, search, reverse-geocoding and nearby places are handled by the backend
// (/api/maps/*), so no map secret lives in this file.
// Leaflet is bundled with the app (no CDN), the screen code below uses window.L.
function loadLeaflet() {
  window.L = L;
  return Promise.resolve();
}

// YYYY-MM-DD in the phone's own time zone (toISOString() is UTC, which is the wrong day
// for early-morning IST jobs).
function localDateKey(d) {
  const x = new Date(d);
  if (isNaN(x)) return "";
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;
}

// Opens turn-by-turn navigation (Google Maps app on phones). Falls back to an address search.
function navLink(b) {
  const lat = Number(b?.coords?.lat), lng = Number(b?.coords?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b?.address || "")}`;
}

// GET helper for the backend map routes (apiGet is defined further down in this file)
const mapsGet = path => apiGet(`/maps/${path}`);

function FullMapScreen({ onConfirm, onClose, C }) {
  const mapRef     = useRef(null);
  const mapObj     = useRef(null);
  const markerRef  = useRef(null);
  const searchRef  = useRef(null);

  const [pinAddr,   setPinAddr]   = useState("");
  const [pinCoords, setPinCoords] = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [mapReady,  setMapReady]  = useState(false);
  const [searchQ,   setSearchQ]   = useState("");
  const [suggests,  setSuggests]  = useState([]);
  const [mapError,  setMapError]  = useState("");
  const [mapNote,   setMapNote]   = useState("");     // GPS / lookup hints shown in the bottom sheet
  const [addrFound, setAddrFound] = useState(true);
  const [nearbyOk,  setNearbyOk]  = useState(false);
  const searchTimer = useRef(null);
  const [activecat, setActivecat] = useState(null);
  const [places,    setPlaces]    = useState([]);

  const nearbyMarkers = useRef([]);

  const CATS = [
    { label:"⛽ Petrol",     key:"petrol_pump", color:"#F0A500" },
    { label:"🍽️ Food",      key:"restaurant",  color:"#F97316" },
    { label:"🏥 Hospital",   key:"hospital",    color:"#F85149" },
    { label:"🏧 ATM",        key:"atm",         color:"#388BFD" },
    { label:"🛒 Grocery",    key:"grocery",     color:"#3FB950" },
  ];

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // 1. Load Leaflet
      try {
        await loadLeaflet();
      } catch {
        setMapError("Could not load map library. Check internet connection.");
        return;
      }
      if (cancelled || !mapRef.current) return;

      // 2. Ask the backend which tiles to use (it holds the Mappls keys)
      let cfg = null;
      try { cfg = await mapsGet("config"); } catch {}
      if (cancelled || !mapRef.current) return;
      if (cfg?.nearby) setNearbyOk(true);
      const tok = null; // kept so the helper calls below stay unchanged; auth now lives on the server

      // 3. Init Leaflet map
      const L   = window.L;
      const map = L.map(mapRef.current, {
        center: [21.1702, 72.8311],  // Surat
        zoom:   14,
        zoomControl: false,
      });

      // Tile layer from the backend config. If the provider's tiles keep failing
      // (wrong key/format, quota), switch to OpenStreetMap so the map is never blank.
      const addOsm = () => L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
      if (cfg?.tileUrl && cfg.provider !== "osm") {
        let loaded = 0, failed = 0;
        const layer = L.tileLayer(cfg.tileUrl, { attribution: cfg.attribution, maxZoom: cfg.maxZoom || 18 }).addTo(map);
        layer.on("tileload",  () => { loaded++; });
        layer.on("tileerror", () => { failed++; if (failed >= 4 && loaded === 0) { map.removeLayer(layer); addOsm(); } });
      } else {
        addOsm();
      }

      // Zoom controls
      L.control.zoom({ position: "bottomright" }).addTo(map);

      mapObj.current = map;
      if (!cancelled) setMapReady(true);

      // 4. GPS. Only a real GPS fix drops a pin automatically. We no longer guess
      // from the IP address (that is city-level, often kilometres off), the customer
      // searches or taps the map instead.
      function locateUser() {
        if (!navigator.geolocation) { setMapNote("Location is not available on this device. Search or tap the map."); return; }
        navigator.geolocation.getCurrentPosition(pos => {
          if (cancelled || !mapObj.current) return;
          const { latitude: lat, longitude: lng } = pos.coords;
          map.setView([lat, lng], 17);
          const blueDot = L.divIcon({
            html: `<div style="width:20px;height:20px;background:#388BFD;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 8px #388BFD44;"></div>`,
            iconSize:[20,20], iconAnchor:[10,10], className:""
          });
          L.marker([lat, lng], { icon: blueDot, zIndexOffset:1000 }).addTo(map);
          dropPin(lat, lng, map, tok);
        }, err => {
          if (cancelled) return;
          setMapNote(err.code === 1
            ? "Location permission is off. Allow it in your browser settings, or search / tap the map."
            : "Couldn't get your GPS location. Search or tap the map to set it.");
        }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
      }
      locateUser();

      // 5. Click on map to drop pin
      map.on("click", e => {
        dropPin(e.latlng.lat, e.latlng.lng, map, tok);
      });
    }

    init();

    return () => {
      cancelled = true;
      if (mapObj.current) { mapObj.current.remove(); mapObj.current = null; }
    };
  }, []);

  async function dropPin(lat, lng, map, tok) {
    const L = window.L;
    const m = mapObj.current || map;
    if (!m || !L) return;

    setPinCoords({ lat, lng });
    setLoading(true);
    setSuggests([]);

    // Remove old pin
    if (markerRef.current) { markerRef.current.remove(); markerRef.current = null; }

    // Amber pin icon
    const pinIcon = L.divIcon({
      html: `<div style="position:relative;width:30px;height:44px;">
        <div style="width:30px;height:30px;background:#F0A500;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid #fff;box-shadow:0 3px 14px #0008;"></div>
        <div style="position:absolute;bottom:0;left:12px;width:6px;height:16px;background:#F0A500;border-radius:0 0 4px 4px;"></div>
      </div>`,
      iconSize: [30, 44], iconAnchor: [15, 44], className: ""
    });

    const marker = L.marker([lat, lng], { icon: pinIcon, draggable: true }).addTo(m);
    markerRef.current = marker;

    // Drag to fine-tune
    marker.on("dragend", e => {
      const p = e.target.getLatLng();
      dropPin(p.lat, p.lng, m, tok);
    });

    // Reverse geocode (backend: Mappls first, OpenStreetMap as fallback)
    setMapNote("");
    try {
      const d = await mapsGet(`reverse?lat=${lat}&lng=${lng}`);
      setPinAddr(d.address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      setAddrFound(d.found !== false);
    } catch {
      setPinAddr(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      setAddrFound(false);
    }
    setLoading(false);
  }

  function handleSearch(q) {
    setSearchQ(q);
    clearTimeout(searchTimer.current);
    if (q.trim().length < 3) { setSuggests([]); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const d = await mapsGet(`search?q=${encodeURIComponent(q.trim())}`);
        setSuggests(d.results || []);
      } catch { setSuggests([]); }
    }, 350);
  }

  function selectSuggest(s) {
    setSuggests([]);
    setSearchQ(s.placeName || "");
    const lat = parseFloat(s.latitude);
    const lng = parseFloat(s.longitude);
    if (mapObj.current && !isNaN(lat)) {
      mapObj.current.setView([lat, lng], 17);
      dropPin(lat, lng, mapObj.current, null);
    }
  }

  async function loadNearby(cat) {
    if (!pinCoords) return;
    if (activecat === cat.key) { setActivecat(null); setPlaces([]); nearbyMarkers.current.forEach(m=>m.remove()); nearbyMarkers.current=[]; return; }
    setActivecat(cat.key);
    nearbyMarkers.current.forEach(m=>m.remove()); nearbyMarkers.current=[];
    try {
      const { lat, lng } = pinCoords;
      const d = await mapsGet(`nearby?lat=${lat}&lng=${lng}&key=${cat.key}`);
      if (d.available === false) { setMapNote("Nearby places aren't available right now."); setActivecat(null); return; }
      const results = d.results || [];
      setPlaces(results);
      const L = window.L;
      const m = mapObj.current;
      if (!L || !m) return;
      results.forEach(pl => {
        const plLat = parseFloat(pl.latitude), plLng = parseFloat(pl.longitude);
        if (isNaN(plLat)) return;
        const dotIcon = L.divIcon({
          html: `<div style="width:14px;height:14px;background:${cat.color};border-radius:50%;border:2px solid #fff;box-shadow:0 1px 6px #0009;"></div>`,
          iconSize:[14,14], iconAnchor:[7,7], className:""
        });
        const mk = L.marker([plLat, plLng], { icon: dotIcon }).addTo(m);
        mk.bindPopup(`<b>${pl.placeName}</b><br><small>${pl.placeAddress||""}</small>`);
        nearbyMarkers.current.push(mk);
      });
    } catch { setPlaces([]); }
  }

  return (
    <div style={{ position:"fixed", inset:0, zIndex:500, display:"flex", flexDirection:"column",
                  userSelect:"none", WebkitUserSelect:"none", WebkitTouchCallout:"none", WebkitTapHighlightColor:"transparent" }}>

      {/* Top search bar */}
      <div style={{ position:"absolute", top:0, left:0, right:0, zIndex:20, padding:"12px 12px 0" }}>
        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          <button onClick={onClose} style={{ width:42, height:42, borderRadius:"50%", background:"rgba(22,27,34,0.95)", border:"none", color:"#E6EDF3", fontSize:18, cursor:"pointer", flexShrink:0 }}>✕</button>
          <div style={{ flex:1, position:"relative" }}>
            <div style={{ display:"flex", alignItems:"center", background:"rgba(22,27,34,0.95)", borderRadius:28, padding:"0 14px", border:"1px solid #21262D" }}>
              <span style={{ fontSize:18, marginRight:8 }}>🔍</span>
              <input
                ref={searchRef}
                value={searchQ}
                onChange={e => handleSearch(e.target.value)}
                placeholder="Search location in Surat..."
                style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#E6EDF3", fontSize:15, padding:"12px 0", fontFamily:"inherit" }}
              />
              {searchQ && <button onClick={() => { setSearchQ(""); setSuggests([]); }} style={{ background:"none", border:"none", color:"#6E7681", fontSize:18, cursor:"pointer", padding:0 }}>✕</button>}
            </div>
            {suggests.length > 0 && (
              <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"rgba(22,27,34,0.98)", borderRadius:14, marginTop:6, overflow:"hidden", boxShadow:"0 8px 32px #000a", border:"1px solid #21262D", zIndex:30 }}>
                {suggests.map((s,i) => (
                  <div key={i} onClick={() => selectSuggest(s)} style={{ padding:"12px 16px", borderBottom:"1px solid #21262D", cursor:"pointer", display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontSize:16 }}>📍</span>
                    <div>
                      <div style={{ color:"#E6EDF3", fontSize:13, fontWeight:600 }}>{s.placeName}</div>
                      <div style={{ color:"#6E7681", fontSize:11, marginTop:2 }}>{s.placeAddress}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Category pills */}
        <div style={{ display: nearbyOk ? "flex" : "none", gap:8, marginTop:10, overflowX:"auto", paddingBottom:4 }}>
          {CATS.map(cat => {
            const active = activecat === cat.key;
            return (
              <button key={cat.key} onClick={() => loadNearby(cat)} style={{
                padding:"8px 16px", borderRadius:20, flexShrink:0,
                background: active ? cat.color : "rgba(22,27,34,0.95)",
                color: active ? "#0D1117" : "#E6EDF3",
                border: active ? "none" : "1px solid #21262D",
                fontWeight:700, fontSize:12, cursor:"pointer", fontFamily:"inherit",
                boxShadow:"0 2px 8px #0006",
              }}>
                {cat.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Map container. zIndex:0 makes this its own stacking context, so Leaflet's internal
          layers (z-index up to 1000) stay inside the map and can no longer paint over the
          search bar and the bottom sheet with the Confirm button. */}
      <div ref={mapRef} style={{ position:"absolute", inset:0, zIndex:0 }} />

      {/* Loading / error overlay */}
      {(!mapReady || mapError) && (
        <div style={{ position:"absolute", inset:0, background:"#0D1117", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", zIndex:15 }}>
          <div style={{ fontSize:52, marginBottom:14 }}>{mapError ? "⚠️" : "🗺️"}</div>
          <div style={{ color:"#E6EDF3", fontWeight:800, fontSize:18, marginBottom:8 }}>{mapError ? "Map Error" : "Loading Map…"}</div>
          <div style={{ color:"#6E7681", fontSize:13, textAlign:"center", maxWidth:280 }}>{mapError || "Loading map tiles from Mappls…"}</div>
        </div>
      )}

      {/* Bottom sheet */}
      <div style={{ position:"absolute", bottom:0, left:0, right:0, zIndex:20 }}>
        {places.length > 0 && (
          <div style={{ background:"rgba(22,27,34,0.97)", maxHeight:170, overflowY:"auto", borderRadius:"16px 16px 0 0", borderTop:"1px solid #21262D" }}>
            <div style={{ padding:"10px 16px 4px", color:"#6E7681", fontSize:11, fontWeight:700, letterSpacing:1 }}>
              NEARBY {(CATS.find(c=>c.key===activecat)?.label||"").replace(/^[^ ]+ /,"").toUpperCase()}
            </div>
            {places.map((pl,i) => (
              <div key={i} onClick={() => {
                const plLat=parseFloat(pl.latitude), plLng=parseFloat(pl.longitude);
                if (!isNaN(plLat) && mapObj.current) mapObj.current.setView([plLat, plLng], 17);
              }} style={{ padding:"10px 16px", borderTop:"1px solid #21262D", display:"flex", alignItems:"center", gap:12, cursor:"pointer" }}>
                <div style={{ width:10, height:10, borderRadius:"50%", background:CATS.find(c=>c.key===activecat)?.color||"#888", flexShrink:0 }}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color:"#E6EDF3", fontSize:13, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{pl.placeName}</div>
                  <div style={{ color:"#6E7681", fontSize:11, marginTop:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{pl.placeAddress}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ background:"rgba(22,27,34,0.97)", padding:"14px 16px 36px", borderTop:"1px solid #21262D" }}>
          {loading ? (
            <div style={{ color:"#6E7681", fontSize:13, textAlign:"center", padding:"6px 0" }}>⏳ Getting your address…</div>
          ) : pinAddr ? (
            <>
              <div style={{ display:"flex", alignItems:"flex-start", gap:10, marginBottom:14 }}>
                <span style={{ fontSize:20, marginTop:2 }}>📍</span>
                <div style={{ flex:1 }}>
                  <div style={{ color:"#6E7681", fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:4 }}>YOUR LOCATION</div>
                  <div style={{ color:"#E6EDF3", fontSize:14, fontWeight:600, lineHeight:1.4 }}>{pinAddr}</div>
                  {!addrFound && <div style={{ color:"#F0A500", fontSize:11, marginTop:4 }}>Couldn't read the street name here. Your pin is saved, add house no. and street in the address box after confirming.</div>}
                </div>
              </div>
              <button onClick={() => onConfirm(pinAddr, pinCoords)} style={{
                width:"100%", padding:"15px 0", background:"#F0A500", color:"#0D1117",
                border:"none", borderRadius:14, fontWeight:800, fontSize:16, cursor:"pointer", fontFamily:"inherit",
              }}>
                ✅ Confirm This Location
              </button>
            </>
          ) : (
            <div style={{ color:"#6E7681", fontSize:14, textAlign:"center", padding:"6px 0" }}>
              {mapNote || (mapReady ? "👆 Tap anywhere on the map to set your location" : "Loading map…")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Backend API ──────────────────────────────────────────────────────────────
// Native helper (Android only): reads "money received" notifications for auto-verify
const UpiWatcher = registerPlugin("UpiWatcher");
const BackgroundGeolocation = registerPlugin("BackgroundGeolocation");   // keeps location going with the screen off (Android app only)
const API_BASE = (import.meta.env.VITE_API_URL || "http://localhost:5000") + "/api";

// The login token goes with every call; the server uses it to know who is asking.
function authHeaders() {
  let t = null; try { t = localStorage.getItem("pt_token"); } catch {}
  return t ? { Authorization: "Bearer " + t } : {};
}
async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function apiPatch(path, body) {
  const res = await fetch(API_BASE + path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ── UPI (manual verification) ────────────────────────────────────────────────
// The receiving UPI ID is set by the admin (Payments tab) and fetched from /api/settings.
const UPI_NAME = "ProWorkers";

function buildUpiParams(upiId, amount, bookingId) {
  return new URLSearchParams({
    pa: upiId, pn: UPI_NAME,
    am: Number(amount).toFixed(2), cu: "INR",
    tn: `ProWorkers ${String(bookingId || "").slice(-6)}`.trim(),
  }).toString();
}

// Customer says "I paid" -> backend stores the UTR and waits for admin verification
async function apiSubmitUtr(bookingId, method, label, utr) {
  const res = await apiPost(`/bookings/${bookingId}/payment-submit`, { method, label, utr });
  return normalizeBooking(res.booking);
}

// Maps a real Booking document (from MongoDB) into the shape the customer-facing
// UI expects. Keeps "id" / "customerLocation" aliases so existing screens don't
// need to change, while everything underneath is real backend data.
function normalizeBooking(b) {
  return {
    ...b,
    id: b._id || b.id,
    _fetchedAt: Date.now(),
    customerLocation: b.address,
    workerLocation: b.workerLocation || "",
    // Defensive: bookings created before the schema fix (or any doc that slipped
    // through) can still have a stale userRating of {} sitting in the DB — an
    // empty object with no `stars`. That's still truthy, so `!!booking.userRating`
    // checks would wrongly treat the booking as already rated. Collapse anything
    // without a real star value down to undefined so downstream code can keep
    // using a simple truthiness check safely.
    userRating: b.userRating?.stars ? b.userRating : undefined,
  };
}

// ── Admin two-step verification (6-digit code emailed to the admin) ───────────
function AdminOtpStep({ challenge, onVerified, onBack }) {
  const AC = { bg:"#0D1117", card:"#161B22", card2:"#1C2333", border:"#21262D", text:"#E6EDF3", muted:"#6E7681", amber:"#F0A500", red:"#F85149", green:"#3FB950" };
  const [code,    setCode]    = useState("");
  const [err,     setErr]     = useState("");
  const [info,    setInfo]    = useState("");
  const [busy,    setBusy]    = useState(false);
  const [cooldown,setCooldown]= useState(30);   // matches the server's 30s resend gap

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function fail(e) {
    const msg = e.message || "Something went wrong.";
    setErr(msg);
    if (/log in again|expired/i.test(msg)) setTimeout(onBack, 2200);
  }
  async function verify() {
    if (!/^\d{6}$/.test(code)) { setErr("Enter the 6-digit code from your email."); return; }
    setBusy(true); setErr(""); setInfo("");
    try {
      const data = await apiPost("/auth/admin-otp/verify", { challengeId: challenge.id, otp: code });
      onVerified(data);
    } catch (e) { fail(e); }
    setBusy(false);
  }
  async function resend() {
    setErr(""); setInfo("");
    try {
      await apiPost("/auth/admin-otp/resend", { challengeId: challenge.id });
      setInfo("A new code was sent."); setCooldown(30); setCode("");
    } catch (e) { fail(e); }
  }

  return (
    <div style={{ minHeight:"100vh", background:AC.bg, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ width:"100%", maxWidth:400, background:AC.card, border:`1px solid ${AC.border}`, borderRadius:20, padding:26, textAlign:"center" }}>
        <div style={{ fontSize:44 }}>🔐</div>
        <div style={{ color:AC.text, fontWeight:900, fontSize:21, marginTop:8 }}>Two-step verification</div>
        <div style={{ color:AC.muted, fontSize:13, marginTop:8, lineHeight:1.5 }}>
          We emailed a 6-digit code to <b style={{ color:AC.text }}>{challenge.masked}</b>. It expires in 5 minutes.
        </div>
        <input
          autoFocus inputMode="numeric" maxLength={6} value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, ""))}
          onKeyDown={e => { if (e.key === "Enter") verify(); }}
          placeholder="••••••"
          style={{ width:"100%", boxSizing:"border-box", marginTop:18, padding:"14px 16px", background:AC.card2, border:`1.5px solid ${AC.border}`, borderRadius:12, color:AC.text, fontSize:26, letterSpacing:10, textAlign:"center", outline:"none", fontFamily:"inherit" }}
        />
        {err  && <div style={{ color:AC.red,   fontSize:12, marginTop:10 }}>{err}</div>}
        {info && <div style={{ color:AC.green, fontSize:12, marginTop:10 }}>{info}</div>}
        <button onClick={verify} disabled={busy} style={{ width:"100%", marginTop:16, padding:"14px 0", background:AC.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:busy?"default":"pointer", opacity:busy?0.6:1, fontFamily:"inherit" }}>
          {busy ? "Verifying…" : "Verify & Sign in"}
        </button>
        <div style={{ display:"flex", justifyContent:"space-between", marginTop:14, fontSize:12 }}>
          <button onClick={onBack} style={{ background:"none", border:"none", color:AC.muted, cursor:"pointer", padding:0, fontFamily:"inherit" }}>← Back to login</button>
          <button onClick={resend} disabled={cooldown>0} style={{ background:"none", border:"none", color:cooldown>0?AC.muted:AC.amber, cursor:cooldown>0?"default":"pointer", padding:0, fontWeight:700, fontFamily:"inherit" }}>
            {cooldown>0 ? `Resend in ${cooldown}s` : "Resend code"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Auth Screen ───────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const { lang, setLang, t } = useLang();
  const [mode,   setMode]   = useState("login");   // "login" | "register"
  const [role,   setRole]   = useState("customer");// "customer" | "worker"
  const [name,   setName]   = useState("");
  const [email,  setEmail]  = useState("");
  const [phone,  setPhone]  = useState("");
  const [loc,    setLoc]    = useState("");
  const [wtype,  setWtype]  = useState("electrician");
  const [pass,   setPass]   = useState("");
  const [confirm,setConfirm]= useState("");
  const [err,    setErr]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [showReset,setShowReset]= useState(false);
  const [challenge,setChallenge]= useState(null);   // set when an admin login needs the emailed code

  const isReg = mode === "register";

  const AC = {
    bg:"#0D1117", card:"#161B22", card2:"#1C2333", border:"#21262D",
    text:"#E6EDF3", muted:"#6E7681", amber:"#F0A500", red:"#F85149", green:"#3FB950"
  };
  const I = {
    width:"100%", padding:"13px 16px", background:AC.card2,
    border:"1.5px solid "+AC.border, borderRadius:12, color:AC.text,
    fontSize:15, outline:"none", boxSizing:"border-box", fontFamily:"inherit"
  };

  function finishLogin(data) {
    localStorage.setItem("pt_token", data.token);
    localStorage.setItem("pt_user",  JSON.stringify(data.user));
    const u = data.user;
    onAuth({ ...u, avatar: (u.name||u.email).slice(0,2).toUpperCase(), token: data.token });
  }

  async function handle() {
    setErr("");
    if (!email.trim() || !pass) { setErr("Email and password are required"); return; }
    if (isReg) {
      if (!name.trim())        { setErr("Full name is required"); return; }
      if (!phone.trim())       { setErr("Phone number is required"); return; }
      if (pass.length < 6)     { setErr("Password must be at least 6 characters"); return; }
      if (pass !== confirm)    { setErr("Passwords do not match"); return; }
    }
    setLoading(true);
    try {
      let data;
      if (isReg) {
        data = await apiPost("/register", {
          name: name.trim(), email: email.trim().toLowerCase(),
          phone: phone.trim(), password: pass, role,
          workerType: role === "worker" ? wtype : null,
          location: loc.trim()
        });
      } else {
        data = await apiPost("/login", {
          email: email.trim().toLowerCase(), password: pass
        });
      }
      if (data.otpRequired) {                       // admin: second step before any token exists
        setChallenge({ id: data.challengeId, masked: data.maskedEmail });
        setLoading(false);
        return;
      }
      finishLogin(data);
    } catch(e) {
      const msg = e.message || "";
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("fetch"))
        setErr("Cannot connect to server. Make sure backend is running on port 5000.");
      else if (msg.includes("not found") || msg.includes("User not found"))
        setErr("No account found with this email. Please register.");
      else if (msg.includes("Wrong password") || msg.includes("Incorrect"))
        setErr("Incorrect password. Please try again.");
      else if (msg.includes("already registered") || msg.includes("duplicate"))
        setErr("This email is already registered. Please sign in.");
      else setErr(msg || "Something went wrong. Try again.");
    }
    setLoading(false);
  }

  if (challenge) {
    return <AdminOtpStep challenge={challenge} onVerified={finishLogin} onBack={() => { setChallenge(null); setPass(""); }} />;
  }

  return (
    <div style={{ minHeight:"100vh", background:AC.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"32px 20px", position:"relative" }}>

      {/* Language switcher — fixed top-right corner */}
      <div style={{ position:"fixed", top:14, right:16, display:"flex", gap:4, background:AC.card2, borderRadius:20, padding:"4px 6px", border:`1px solid ${AC.border}`, zIndex:100 }}>
        {LANGUAGES.map(l => (
          <button key={l.code} onClick={() => setLang(l.code)} style={{
            padding:"5px 12px", borderRadius:16, border:"none", cursor:"pointer",
            background: lang===l.code ? AC.amber : "transparent",
            color: lang===l.code ? "#000" : AC.muted,
            fontWeight:700, fontSize:13, fontFamily:"inherit", transition:"all 0.15s",
          }}>{l.code==="en" ? "EN" : l.native}</button>
        ))}
      </div>

      {/* Website only: download the Android app */}
      {!Capacitor.isNativePlatform() && (
        <a href={import.meta.env.VITE_APK_URL || "/proworkers.apk"} download="ProWorkers.apk" style={{
          position:"fixed", top:14, left:16, zIndex:100, textDecoration:"none",
          background:AC.amber, color:"#000", fontWeight:800, fontSize:13, padding:"8px 14px",
          borderRadius:20, display:"flex", alignItems:"center", gap:6,
        }}>⬇ Download Android App</a>
      )}

      {/* Logo */}
      <div style={{ textAlign:"center", marginBottom:32 }}>
        <img src="/logo.jpg" alt="ProWorkers" style={{ height:100, width:"auto", borderRadius:16, objectFit:"contain", marginBottom:10 }}/>
        <div style={{ fontWeight:900, fontSize:32, letterSpacing:-0.5 }}>
          <span style={{ color:AC.amber }}>Pro</span><span style={{ color:AC.text }}>Workers</span>
        </div>
        <div style={{ color:AC.muted, fontSize:13, marginTop:6 }}>{t("app_tagline")}</div>
      </div>

      <div style={{ width:"100%", maxWidth:400 }}>

        {/* Role selector — only shown on Register, as icon cards */}
        {isReg && (
          <div style={{ marginBottom:20 }}>
            <div style={{ color:AC.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:10 }}>{t("i_am_a")}</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              {[["customer","👤",t("role_customer"),t("role_customer_sub")],
                ["worker","🔧",t("role_worker"),t("role_worker_sub")]].map(([r,icon,label,sub]) => (
                <div key={r} onClick={() => setRole(r)} style={{
                  padding:"16px 12px", borderRadius:14, cursor:"pointer", textAlign:"center",
                  border:"2px solid "+(role===r ? AC.amber : AC.border),
                  background: role===r ? AC.amber+"18" : AC.card2,
                  transition:"all 0.2s"
                }}>
                  <div style={{ fontSize:28, marginBottom:6 }}>{icon}</div>
                  <div style={{ color:role===r?AC.amber:AC.text, fontWeight:800, fontSize:14 }}>{label}</div>
                  <div style={{ color:AC.muted, fontSize:11, marginTop:3 }}>{sub}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={e => { e.preventDefault(); handle(); }} autoComplete="on">
        {/* Register fields */}
        {isReg && (
          <>
            <div style={{ marginBottom:12 }}>
              <label style={{ color:AC.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:6, letterSpacing:1 }}>{t("full_name")}</label>
              <input style={I} name="name" autoComplete="name" placeholder={t("full_name_ph")} value={name} onChange={e=>setName(e.target.value)}/>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ color:AC.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:6, letterSpacing:1 }}>{t("phone")}</label>
              <input style={I} type="tel" name="phone" autoComplete="tel" placeholder="+91 98765 00000" value={phone} onChange={e=>setPhone(e.target.value)}/>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ color:AC.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:6, letterSpacing:1 }}>{t("your_area")}</label>
              <input style={I} placeholder={t("your_area_ph")} value={loc} onChange={e=>setLoc(e.target.value)}/>
            </div>
            {role==="worker" && (
              <div style={{ marginBottom:12 }}>
                <label style={{ color:AC.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:6, letterSpacing:1 }}>{t("your_skill")}</label>
                <select style={I} value={wtype} onChange={e=>setWtype(e.target.value)}>
                  {Object.entries(SERVICES).map(([k,v])=>(
                    <option key={k} value={k}>{v.icon} {v.label}</option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}

        {/* Email */}
        <div style={{ marginBottom:12 }}>
          <label style={{ color:AC.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:6, letterSpacing:1 }}>{t("email")}</label>
          <input style={I} type="email" name="email" id="pw-email" autoComplete={isReg ? "email" : "username"} placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)}/>
        </div>

        {/* Password */}
        <div style={{ marginBottom:8 }}>
          <label style={{ color:AC.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:6, letterSpacing:1 }}>{t("password")}</label>
          <PasswordInput style={I} name="password" id="pw-password" autoComplete={isReg ? "new-password" : "current-password"} placeholder="••••••••" value={pass}
            onChange={e=>setPass(e.target.value)}/>
        </div>
        {!isReg && (
          <div style={{ textAlign:"right", marginBottom:18 }}>
            <span onClick={()=>setShowReset(true)} style={{ color:AC.amber, fontSize:13, fontWeight:600, cursor:"pointer" }}>{t("forgot_password")}</span>
          </div>
        )}

        {isReg && (
          <div style={{ marginBottom:24 }}>
            <label style={{ color:AC.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:6, letterSpacing:1 }}>{t("confirm_password")}</label>
            <PasswordInput style={I} name="confirm" autoComplete="new-password" placeholder="••••••••" value={confirm} onChange={e=>setConfirm(e.target.value)}/>
          </div>
        )}

        {/* Error box */}
        {err && (
          <div style={{ background:"#F8514920", border:"1px solid #F8514966", color:"#F85149", fontSize:13, padding:"12px 14px", borderRadius:10, marginBottom:16, lineHeight:1.6 }}>
            ⚠️ {err}
          </div>
        )}

        {/* Submit */}
        <button type="submit" disabled={loading} style={{
          width:"100%", padding:"17px 0", background: loading ? AC.border : AC.amber,
          color:"#0D1117", border:"none", borderRadius:14, fontWeight:800, fontSize:17,
          cursor: loading ? "not-allowed" : "pointer", fontFamily:"inherit", marginBottom:16
        }}>
          {loading ? t("please_wait") : isReg ? t("create_account") : t("sign_in")}
        </button>
        </form>

        <div style={{ textAlign:"center", color:AC.muted, fontSize:13 }}>
          {isReg ? t("already_registered") : t("new_to_app")}
          <span onClick={() => { setMode(isReg?"login":"register"); setErr(""); }}
            style={{ color:AC.amber, fontWeight:700, cursor:"pointer" }}>
            {isReg ? t("sign_in_link") : t("create_account_link")}
          </span>
        </div>
      </div>
      {showReset && <ResetPasswordModal AC={AC} onClose={()=>setShowReset(false)}/>}
    </div>
  );
}

// ── Reset Password Modal ──────────────────────────────────────────────────────
function ResetPasswordModal({ AC, onClose }) {
  const [step,    setStep]   = useState(1);
  const [email,   setEmail]  = useState("");
  const [otp,     setOtp]    = useState("");
  const [pass,    setPass]   = useState("");
  const [confirm, setCon]    = useState("");
  const [err,     setErr]    = useState("");
  const [loading, setLoad]   = useState(false);
  const [done,    setDone]   = useState(false);
  const I = { width:"100%", padding:"13px 16px", background:AC.card2, border:"1.5px solid "+AC.border, borderRadius:12, color:AC.text, fontSize:15, outline:"none", boxSizing:"border-box", fontFamily:"inherit" };

  // The OTP used to be generated and checked entirely in the browser, then
  // shown via alert() instead of actually being emailed — and the reset
  // endpoint never checked it at all, so anyone who knew an account's email
  // could reset the password with no OTP needed. Both send and verify now
  // go through the backend, which emails a real code and is the only place
  // that decides whether an OTP is correct.
  async function sendOtp() {
    if (!email.trim()) { setErr("Enter your registered email"); return; }
    setLoad(true); setErr("");
    try {
      const res  = await fetch(API_BASE + "/send-otp", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ email: email.toLowerCase().trim() }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStep(2);
    } catch(e) { setErr(e.message || "Could not send OTP"); }
    setLoad(false);
  }
  async function verifyOtp() {
    setLoad(true); setErr("");
    try {
      const res  = await fetch(API_BASE + "/verify-otp", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ email: email.toLowerCase().trim(), otp }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStep(3);
    } catch(e) { setErr(e.message || "Incorrect OTP. Try again."); }
    setLoad(false);
  }
  async function resetPass() {
    if (pass.length < 6) { setErr("Password must be at least 6 characters"); return; }
    if (pass !== confirm) { setErr("Passwords do not match"); return; }
    setLoad(true); setErr("");
    try {
      const res  = await fetch(API_BASE + "/reset-password", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ email:email.toLowerCase().trim(), password:pass }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDone(true);
    } catch(e) { setErr(e.message||"Reset failed"); }
    setLoad(false);
  }
  return (
    <div style={{ position:"fixed", inset:0, background:"#000c", zIndex:800, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:AC.card, borderRadius:20, padding:28, width:"100%", maxWidth:380, border:"1px solid "+AC.border }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <span style={{ color:AC.text, fontWeight:900, fontSize:18 }}>Reset Password</span>
          <button onClick={onClose} style={{ background:"none", border:"none", color:AC.muted, fontSize:22, cursor:"pointer" }}>✕</button>
        </div>
        {done ? (
          <div style={{ textAlign:"center", padding:20 }}>
            <div style={{ fontSize:44, marginBottom:12 }}>✅</div>
            <div style={{ color:"#3FB950", fontWeight:800, fontSize:16 }}>Password reset successfully!</div>
            <button onClick={onClose} style={{ marginTop:20, width:"100%", padding:"13px 0", background:AC.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>Back to Sign In</button>
          </div>
        ) : <>
          {step===1 && <>
            <p style={{ color:AC.muted, fontSize:13, marginBottom:16 }}>Enter your registered email to receive an OTP.</p>
            <input style={I} type="email" placeholder="your@email.com" value={email} onChange={e=>setEmail(e.target.value)}/>
            {err && <div style={{ color:"#F85149", fontSize:13, marginTop:8 }}>⚠️ {err}</div>}
            <button onClick={sendOtp} disabled={loading} style={{ marginTop:16, width:"100%", padding:"13px 0", background:AC.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:loading?"not-allowed":"pointer", opacity:loading?0.7:1, fontFamily:"inherit" }}>{loading?"Sending…":"Send OTP"}</button>
          </>}
          {step===2 && <>
            <p style={{ color:AC.muted, fontSize:13, marginBottom:16 }}>Enter the 6-digit OTP emailed to <b style={{ color:AC.text }}>{email}</b></p>
            <input style={{ ...I, letterSpacing:8, fontSize:20, textAlign:"center" }} maxLength={6} placeholder="000000" value={otp} onChange={e=>setOtp(e.target.value)}/>
            {err && <div style={{ color:"#F85149", fontSize:13, marginTop:8 }}>⚠️ {err}</div>}
            <button onClick={verifyOtp} disabled={loading} style={{ marginTop:16, width:"100%", padding:"13px 0", background:AC.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:loading?"not-allowed":"pointer", opacity:loading?0.7:1, fontFamily:"inherit" }}>{loading?"Verifying…":"Verify OTP"}</button>
            <div onClick={()=>{setStep(1);setErr("");setOtp("");}} style={{ textAlign:"center", marginTop:12, color:AC.muted, fontSize:13, cursor:"pointer" }}>← Change email</div>
          </>}
          {step===3 && <>
            <PasswordInput wrapStyle={{ marginBottom:12 }} style={I} placeholder="New password" value={pass} onChange={e=>setPass(e.target.value)}/>
            <PasswordInput style={I} placeholder="Confirm new password" value={confirm} onChange={e=>setCon(e.target.value)}/>
            {err && <div style={{ color:"#F85149", fontSize:13, marginTop:8 }}>⚠️ {err}</div>}
            <button onClick={resetPass} disabled={loading} style={{ marginTop:16, width:"100%", padding:"13px 0", background:AC.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>{loading?"Saving…":"Set New Password"}</button>
          </>}
        </>}
      </div>
    </div>
  );
}

// ── Payment Modal ─────────────────────────────────────────────────────────────
function PaymentModal({ total, jobTotal, platformMarkup, cashCharge = 0, noCash = false, svc, workerName, workerAvatar, bookingId, onSubmitUtr, onPay, onClose, C }) {
  const [step,    setStep]    = useState("choose");
  const [method,  setMethod]  = useState("");
  const [cardNum, setCardNum] = useState("");
  const [cardExp, setCardExp] = useState("");
  const [cardCvv, setCardCvv] = useState("");
  const [rating,  setRating]  = useState(null); // saved rating after payment
  const [utr,     setUtr]     = useState("");
  const [utrErr,  setUtrErr]  = useState("");
  const [utrBusy, setUtrBusy] = useState(false);
  const [copied,  setCopied]  = useState(false);
  const [secsLeft, setSecsLeft] = useState(120);   // 2-minute wait after "I've Paid"
  const [verified, setVerified] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [UPI_ID,  setUpiId]   = useState("");   // fetched fresh each time the modal opens
  useEffect(() => {
    apiGet("/settings").then(d => setUpiId(d.upiId || "")).catch(() => {});
  }, []);
  // While waiting: tick the 2:00 countdown and ask the server every 3s whether the
  // admin has decided. Polling continues after 0:00 — the wait ends only on a decision.
  useEffect(() => {
    if (step !== "waiting") return;
    const tick = setInterval(() => setSecsLeft(n => (n > 0 ? n - 1 : 0)), 1000);
    const poll = setInterval(async () => {
      try {
        const b = await apiGet(`/bookings/${bookingId}`);
        if (b.paymentStatus === "verified") { setVerified(true); setStep("rate"); }
        else if (b.paymentStatus === "rejected") { setRejectNote(b.paymentNote || ""); setStep("rejected"); }
      } catch {}
    }, 3000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  const I = inp(C);

  // One real receiving UPI ID; same encoded params for every app.
  // On Android the generic upi:// link opens the system app chooser; the
  // app-specific schemes are mainly for iPhone.
  const upiQuery = buildUpiParams(UPI_ID, total, bookingId);
  const UPI_APPS = [
    { id:"gpay",    label:"Google Pay",    emoji:"🟢", dl:`gpay://upi/pay?${upiQuery}` },
    { id:"phonepe", label:"PhonePe",       emoji:"🟣", dl:`phonepe://pay?${upiQuery}` },
    { id:"paytm",   label:"Paytm",         emoji:"🔵", dl:`paytmmp://pay?${upiQuery}` },
    { id:"bhim",    label:"Other UPI App", emoji:"🟠", dl:`upi://pay?${upiQuery}` },
  ];
  const upiLink = `upi://pay?${upiQuery}`;

  // Opening the UPI app does NOT mean the payment happened. We only move on to
  // the UTR step; the booking is marked paid after the admin verifies it.
  function openUpi(app) {
    try { window.location.href = app.dl; } catch {}
    setMethod("upi_"+app.id);
    setUtrErr("");
    setStep("utr");
  }
  async function submitUtr() {
    const clean = utr.trim();
    if (clean && !/^\d{12}$/.test(clean)) { setUtrErr("UTR must be 12 digits (or leave it empty)."); return; }
    setUtrBusy(true); setUtrErr("");
    try {
      const lbl = ({gpay:"Google Pay",phonepe:"PhonePe",paytm:"Paytm",bhim:"UPI"})[method.replace("upi_","")] || "UPI";
      await onSubmitUtr(method, lbl, clean);
      setSecsLeft(120);
      setStep("waiting");
    } catch (e) {
      setUtrErr(e.message || "Could not submit. Try again.");
    }
    setUtrBusy(false);
  }
  function copyUpiId() {
    try { navigator.clipboard.writeText(UPI_ID); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  }
  function payCard() {
    setMethod("card");
    setStep("processing");
    setTimeout(() => setStep("rate"), 2200);
  }
  function payCash() {
    setMethod("cash");
    setStep("alldone");   // rating comes later, once the worker confirms the cash
    setTimeout(() => onPay("cash", "Cash", null), 1800);
  }
  function handleRatingDone(r) {
    setRating(r);
    setStep("alldone");
    setTimeout(() => onPay(method, method==="cash"?"Cash":method.startsWith("upi_")?{gpay:"Google Pay",phonepe:"PhonePe",paytm:"Paytm",bhim:"BHIM"}[method.replace("upi_","")]:"Card", r), 1800);
  }

  return (
    <div onClick={step==="choose"?onClose:undefined} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.82)", zIndex:300, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:C.card, borderRadius:"24px 24px 0 0", padding:"20px 20px 36px", width:"100%", maxWidth:480, border:`1px solid ${C.border}`, maxHeight:"92vh", overflowY:"auto" }}>
        <div style={{ width:40, height:4, borderRadius:2, background:C.border, margin:"0 auto 20px" }}/>

        {step==="processing" && (
          <div style={{ textAlign:"center", padding:"32px 0" }}>
            <div style={{ fontSize:44 }}>⏳</div>
            <div style={{ color:C.text, fontWeight:800, fontSize:18, marginTop:12 }}>Processing Payment…</div>
            <div style={{ color:C.muted, fontSize:13, marginTop:4 }}>Please wait</div>
          </div>
        )}

        {step==="rate" && (
          <>
            <div style={{ textAlign:"center", marginBottom:20 }}>
              <div style={{ fontSize:42 }}>{(method==="cash"||(method.startsWith("upi_")&&!verified)) ? "⏳" : "✅"}</div>
              <div style={{ color:(method==="cash"||(method.startsWith("upi_")&&!verified))?C.amber:C.green, fontWeight:900, fontSize:18, marginTop:10 }}>
                {method==="cash" ? "Cash Payment Selected" : method.startsWith("upi_") ? (verified ? "Payment Verified!" : "Payment Submitted") : "Payment Successful!"}
              </div>
              <div style={{ color:C.muted, fontSize:13, marginTop:4 }}>
                {method==="cash"
                  ? `₹${total+cashCharge} due in cash (includes ₹${cashCharge} cash platform charge) — this will show as paid once ${workerName||"the worker"} confirms they received it.`
                  : method.startsWith("upi_")
                    ? (verified ? `₹${total} received. Thank you!` : `₹${total} — we'll mark it paid as soon as we verify it.`)
                    : `₹${total}`}
              </div>
            </div>
            <div style={{ background:C.card2, borderRadius:16, padding:18, border:`1px solid ${svc.color}44` }}>
              <InlineRating C={C} svc={svc} workerName={workerName} workerAvatar={workerAvatar} onSubmit={handleRatingDone} />
            </div>
            <button
              onClick={() => {
                const lbl = method==="cash"?"Cash":method.startsWith("upi_")?({gpay:"Google Pay",phonepe:"PhonePe",paytm:"Paytm",bhim:"BHIM"})[method.replace("upi_","")]:"Card";
                onPay(method, lbl, null);
              }}
              style={{ width:"100%", marginTop:12, padding:"13px 0", background:"transparent", color:C.muted, border:`1px solid ${C.border}`, borderRadius:12, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}
            >
              Skip — I'll rate later in Bookings
            </button>
          </>
        )}

        {step==="alldone" && (
          <div style={{ textAlign:"center", padding:"32px 0" }}>
            <div style={{ fontSize:52 }}>{(method==="cash"||(method.startsWith("upi_")&&!verified)) ? "⏳" : "🌟"}</div>
            <div style={{ color:(method==="cash"||(method.startsWith("upi_")&&!verified))?C.amber:C.green, fontWeight:900, fontSize:20, marginTop:12 }}>
              {method==="cash" ? "Waiting on Worker Confirmation" : method.startsWith("upi_") ? (verified ? "All Done!" : "Waiting for Payment Verification") : "All Done!"}
            </div>
            <div style={{ color:C.muted, fontSize:13, marginTop:6 }}>
              {method==="cash" ? "We'll mark this as paid as soon as they confirm." : method.startsWith("upi_") && !verified ? "We'll notify you once your payment is verified." : "Your rating was saved. Thank you!"}
            </div>
          </div>
        )}

        {step==="waiting" && (
          <div style={{ textAlign:"center", padding:"20px 0 10px" }}>
            <div style={{ width:120, height:120, borderRadius:"50%", border:`6px solid ${secsLeft>0?C.amber:C.border}`, margin:"0 auto", display:"flex", alignItems:"center", justifyContent:"center", color:C.text, fontWeight:900, fontSize:30, fontVariantNumeric:"tabular-nums" }}>
              {Math.floor(secsLeft/60)}:{String(secsLeft%60).padStart(2,"0")}
            </div>
            <div style={{ color:C.amber, fontWeight:900, fontSize:19, marginTop:16 }}>Waiting for admin to verify</div>
            <div style={{ color:C.muted, fontSize:13, marginTop:8, lineHeight:1.5 }}>
              {secsLeft>0
                ? `We're checking your ₹${Number(total).toFixed(2)} payment. Please keep this screen open.`
                : "Taking a little longer than usual. You can keep waiting, or close this — we'll notify you as soon as it's verified."}
            </div>
            {secsLeft===0 && (
              <button onClick={() => onPay(method, "UPI", null)} style={{ marginTop:16, width:"100%", padding:"13px 0", background:"transparent", color:C.muted, border:`1px solid ${C.border}`, borderRadius:12, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>
                Close — notify me when verified
              </button>
            )}
          </div>
        )}

        {step==="rejected" && (
          <div style={{ textAlign:"center", padding:"20px 0 10px" }}>
            <div style={{ fontSize:48 }}>❌</div>
            <div style={{ color:C.red, fontWeight:900, fontSize:19, marginTop:10 }}>Payment not verified</div>
            <div style={{ color:C.muted, fontSize:13, marginTop:8, lineHeight:1.5 }}>{rejectNote || "We could not find your payment. If money was deducted, contact support."}</div>
            <button onClick={() => { setUtr(""); setUtrErr(""); setStep("choose"); }} style={{ marginTop:16, width:"100%", padding:"14px 0", background:C.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>
              Pay Again
            </button>
          </div>
        )}

        {step==="utr" && (
          <>
            <button onClick={() => setStep("choose")} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:14, marginBottom:14, padding:0 }}>← Back</button>
            <div style={{ color:C.text, fontWeight:900, fontSize:20, marginBottom:4 }}>Confirm your UPI payment</div>
            <div style={{ color:C.muted, fontSize:12, marginBottom:14, lineHeight:1.5 }}>
              Pay exactly <b style={{ color:C.amber }}>₹{Number(total).toFixed(2)}</b> in your UPI app. Then come back here and tap <b>I've Paid</b>.
            </div>
            <div style={{ background:C.card2, border:`1px solid ${C.border}`, borderRadius:14, padding:14, marginBottom:14, textAlign:"center" }}>
              <div style={{ display:"inline-block", background:"#fff", padding:8, borderRadius:10 }}>
                <QRCodeSVG value={upiLink} size={150} />
              </div>
              <div style={{ color:C.muted, fontSize:11, marginTop:8 }}>No app opened? Scan this QR with any UPI app, or pay to:</div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, marginTop:6 }}>
                <span style={{ color:C.text, fontWeight:800, fontSize:14 }}>{UPI_ID}</span>
                <button onClick={copyUpiId} style={{ background:C.amber, color:"#0D1117", border:"none", borderRadius:8, padding:"4px 10px", fontSize:11, fontWeight:800, cursor:"pointer" }}>{copied ? "Copied ✓" : "Copy"}</button>
              </div>
            </div>
            <input
              style={{ ...I, marginBottom:8, letterSpacing:2 }} inputMode="numeric" maxLength={12}
              placeholder="UTR / Transaction ID (optional, faster verification)"
              value={utr} onChange={e => setUtr(e.target.value.replace(/\D/g, ""))}
            />
            {utrErr && <div style={{ color:C.red, fontSize:12, marginBottom:8 }}>{utrErr}</div>}
            <button onClick={submitUtr} disabled={utrBusy} style={{ width:"100%", padding:"15px 0", background:C.amber, color:"#0D1117", border:"none", borderRadius:14, fontWeight:800, fontSize:15, cursor:utrBusy?"default":"pointer", opacity:utrBusy?0.6:1, fontFamily:"inherit" }}>
              {utrBusy ? "Submitting…" : "✅ I've Paid"}
            </button>
            <div style={{ color:C.muted, fontSize:11, marginTop:10, textAlign:"center" }}>Your booking is marked paid after the admin verifies the payment (usually about 2 minutes).</div>
          </>
        )}

        {step==="choose" && (
          <>
            <div style={{ marginBottom:16 }}>
              <div style={{ color:C.text, fontWeight:900, fontSize:22, marginBottom:8 }}>Pay ₹{total}</div>
              <div style={{ background:C.card2, borderRadius:10, padding:"10px 14px", fontSize:12 }}>
                <div style={{ display:"flex", justifyContent:"space-between", color:C.muted, marginBottom:4 }}><span>{noCash ? "Travel fee (worker was on the way)" : "Service charge"}</span><span>₹{jobTotal||total}</span></div>
                {(platformMarkup ?? 0) > 0 && <div style={{ display:"flex", justifyContent:"space-between", color:C.amber }}><span>🏷️ ProWorkers platform charge</span><span>+₹{platformMarkup}</span></div>}
              </div>
              <div style={{ color:C.muted, fontSize:12, marginTop:6 }}>Choose payment method</div>
            </div>

            {/* UPI */}
            <div style={{ background:`${C.amber}12`, border:`1.5px solid ${C.amber}55`, borderRadius:14, padding:16, marginBottom:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                <div style={{ color:C.amber, fontWeight:800, fontSize:15 }}>📱 Pay via UPI</div>
                <span style={{ background:`${C.amber}22`, color:C.amber, fontSize:10, fontWeight:700, padding:"3px 8px", borderRadius:10 }}>RECOMMENDED</span>
              </div>
              {!UPI_ID && <div style={{ color:C.red, fontSize:12, marginBottom:10 }}>⚠️ UPI payments are not set up yet. Please try again later.</div>}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, opacity:UPI_ID?1:0.4, pointerEvents:UPI_ID?"auto":"none" }}>
                {UPI_APPS.map(app => (
                  <button key={app.id} onClick={() => openUpi(app)} style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", background:C.card2, border:`1px solid ${C.border}`, borderRadius:12, cursor:"pointer", fontFamily:"inherit" }}>
                    <span style={{ fontSize:22 }}>{app.emoji}</span>
                    <span style={{ color:C.text, fontWeight:700, fontSize:13 }}>{app.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Card is disabled until a real payment gateway is connected: the old form marked bookings paid without charging anything. */}
            <button disabled style={{ width:"100%", display:"flex", alignItems:"center", gap:12, padding:"14px 16px", background:C.card2, border:`1.5px solid ${C.border}`, borderRadius:14, cursor:"not-allowed", marginBottom:10, fontFamily:"inherit", opacity:0.45 }}>
              <span style={{ fontSize:22 }}>💳</span>
              <div style={{ textAlign:"left" }}><div style={{ color:C.text, fontWeight:700, fontSize:14 }}>Debit / Credit Card</div><div style={{ color:C.muted, fontSize:11, marginTop:1 }}>Coming soon</div></div>
            </button>

            {!noCash && <button onClick={payCash} style={{ width:"100%", display:"flex", alignItems:"center", gap:12, padding:"14px 16px", background:C.card2, border:`1.5px solid ${C.border}`, borderRadius:14, cursor:"pointer", fontFamily:"inherit" }}>
              <span style={{ fontSize:22 }}>💵</span>
              <div style={{ textAlign:"left" }}><div style={{ color:C.text, fontWeight:700, fontSize:14 }}>Cash on Completion</div><div style={{ color:C.muted, fontSize:11, marginTop:1 }}>Pay worker directly{cashCharge>0 ? ` · +₹${cashCharge} cash platform charge = ₹${total+cashCharge}` : ""}</div></div>
              <span style={{ marginLeft:"auto", color:C.muted, fontSize:18 }}>›</span>
            </button>}
          </>
        )}

        {step==="card" && (
          <>
            <button onClick={() => setStep("choose")} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:14, marginBottom:18, padding:0 }}>← Back</button>
            <div style={{ color:C.text, fontWeight:900, fontSize:18, marginBottom:20 }}>💳 Card Details</div>
            <input style={{ ...I, marginBottom:10 }} placeholder="Card Number" value={cardNum} onChange={e=>setCardNum(e.target.value)} maxLength={19}/>
            <div style={{ display:"flex", gap:10, marginBottom:20 }}>
              <input style={{ ...I, flex:1 }} placeholder="MM / YY" value={cardExp} onChange={e=>setCardExp(e.target.value)} maxLength={5}/>
              <input style={{ ...I, flex:1 }} placeholder="CVV" value={cardCvv} onChange={e=>setCardCvv(e.target.value)} maxLength={3} type="password"/>
            </div>
            <button onClick={payCard} style={{ width:"100%", padding:"16px 0", background:C.amber, color:"#0D1117", border:"none", borderRadius:14, fontWeight:800, fontSize:16, cursor:"pointer", fontFamily:"inherit" }}>Pay ₹{total}</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Booking Detail Modal ──────────────────────────────────────────────────────
// Label + colours for a customer's booking status chip (cancelled bookings are shown clearly, with any travel fee)
function bookingChip(bk, C) {
  if (bk.status === "cancelled") {
    if (bk.cancelFee > 0) return bk.paid ? { text:"✕ Cancelled · fee paid", color:C.muted } : bk.paymentStatus==="pending_verification" ? { text:"⏳ Verifying fee", color:C.amber } : { text:`✕ Cancelled · fee ₹${bk.cancelFee} due`, color:C.red };
    return { text:"✕ Cancelled", color:C.red };
  }
  if (bk.scheduledFor && !bk.released && !bk.workerName) return { text:"📅 Scheduled", color:C.amber };
  return bk.paid ? { text:"✓ Paid", color:C.green } : bk.paymentStatus==="pending_verification" ? { text:"⏳ Verifying", color:C.amber } : { text:"Pending", color:C.amber };
}

function BookingDetailModal({ booking, onClose, onComplaint, onRated, onRebook, C }) {
  const [showRateForm, setShowRateForm] = useState(false);
  const [rated, setRated] = useState(!!booking.userRating);
  const [rateErr, setRateErr] = useState("");
  const [favIds, setFavIds] = useState(null);     // null = still loading
  const [favBusy, setFavBusy] = useState(false);
  useEffect(() => {
    if (!booking?.workerId) return;
    apiGet("/customer/favorites").then(r => setFavIds((r.favorites || []).map(f => String(f.id)))).catch(() => setFavIds([]));
  }, [booking?.workerId]);
  if (!booking) return null;
  const svc = SERVICES[booking.serviceType] || SERVICES.electrician;
  const isFav = !!(favIds && booking.workerId && favIds.includes(String(booking.workerId)));
  async function toggleFavourite() {
    setFavBusy(true);
    try { const r = await apiPost("/customer/favorites", { workerId: String(booking.workerId), favorite: !isFav }); setFavIds((r.favoriteWorkerIds || []).map(String)); } catch {}
    setFavBusy(false);
  }

  const rows = [
    ["📅 Date",     booking.date],
    ["⏰ Time",     booking.time || "—"],
    ["📍 Location", booking.customerLocation],
    ["👷 Worker",   booking.workerName || (booking.status==="cancelled" ? "Not assigned" : "—")],
    ["⭐ Rating",   booking.workerRating ? `${booking.workerRating} / 5` : "—"],
    ["🛠️ Category", svc.label],
    ["💰 Amount",   booking.status==="cancelled" ? (booking.cancelFee>0 ? `₹${booking.cancelFee} travel fee` : "No charge") : `₹${booking.total}`],
    ["💳 Payment",  booking.status==="cancelled" && !(booking.cancelFee>0) ? "Nothing to pay" : booking.paid ? (booking.paymentLabel || "Paid") : booking.paymentStatus==="pending_verification" ? "Verifying…" : "Pending"],
    ["📞 Phone",    booking.workerPhone || "—"],
  ];

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:250, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:C.card, borderRadius:"24px 24px 0 0", width:"100%", maxWidth:480, maxHeight:"92vh", overflowY:"auto", border:`1px solid ${C.border}` }}>
        <div style={{ width:40, height:4, borderRadius:2, background:C.border, margin:"16px auto 0" }}/>

        {/* Header */}
        <div style={{ padding:"18px 20px 0", display:"flex", alignItems:"center", gap:14 }}>
          <Av initials={booking.workerAvatar} color={svc.color} size={54}/>
          <div style={{ flex:1 }}>
            <div style={{ color:C.text, fontWeight:900, fontSize:17 }}>{booking.workerName || (booking.status==="cancelled" ? "Booking cancelled" : "Finding a worker")}</div>
            <div style={{ color:C.muted, fontSize:13, marginTop:2 }}>{svc.icon} {svc.label}</div>
            <Stars n={booking.workerRating||0} C={C}/>
          </div>
          {(() => { const ch = bookingChip(booking, C); return (
            <span style={{ background:`${ch.color}22`, color:ch.color, fontSize:12, fontWeight:700, padding:"6px 14px", borderRadius:20, textAlign:"center" }}>{ch.text}</span>
          ); })()}
        </div>
        <div style={{ padding:"8px 20px 0", color:C.muted, fontSize:12 }}>Booking ID: <span style={{ color:C.amber, fontWeight:700 }}>#{booking.id}</span></div>
        {booking.workerId && booking.workerName && favIds !== null && (
          <div style={{ padding:"12px 20px 0" }}>
            <button onClick={toggleFavourite} disabled={favBusy} style={{ width:"100%", padding:"11px 0", borderRadius:12, border:`1.5px solid ${C.red}66`, background: isFav ? `${C.red}22` : "transparent", color:C.red, fontWeight:800, fontSize:14, cursor:"pointer", fontFamily:"inherit", opacity: favBusy ? 0.6 : 1 }}>
              {isFav ? `❤️ ${booking.workerName} is your favourite` : `🤍 Add ${booking.workerName} to favourites`}
            </button>
          </div>
        )}

        {/* Detail rows */}
        <div style={{ margin:"16px 20px 0", background:C.card2, borderRadius:14, overflow:"hidden" }}>
          {rows.map(([k,v],i) => (
            <div key={k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", borderBottom:i<rows.length-1?`1px solid ${C.border}`:"none" }}>
              <span style={{ color:C.muted, fontSize:13 }}>{k}</span>
              <span style={{ color:C.text, fontSize:13, fontWeight:600, textAlign:"right", maxWidth:"58%" }}>{v}</span>
            </div>
          ))}
        </div>

        {/* Services */}
        <div style={{ margin:"16px 20px 0" }}>
          <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:10 }}>SERVICES BOOKED</div>
          {booking.items.map((item,idx) => (
            <div key={idx} style={{ display:"flex", justifyContent:"space-between", padding:"9px 0", borderBottom:`1px solid ${C.border}` }}>
              <span style={{ color:C.sub, fontSize:13 }}>{item.name}{qtyText(item) ? ` · ${qtyText(item)}` : ""}</span>
              <span style={{ color:svc.color, fontWeight:700, fontSize:13 }}>₹{item.price*(item.qty||1)}</span>
            </div>
          ))}
          {booking.status === "cancelled" ? (
            <div style={{ display:"flex", justifyContent:"space-between", padding:"12px 0", fontWeight:900, color: booking.cancelFee>0 ? C.amber : C.muted, fontSize:15 }}>
              <span>{booking.cancelFee>0 ? "Travel fee (cancelled)" : "Cancelled · no charge"}</span><span>{booking.cancelFee>0 ? `₹${booking.cancelFee}` : "₹0"}</span>
            </div>
          ) : (<>
          {booking.platformFee > 0 && (
            <>
              <div style={{ display:"flex", justifyContent:"space-between", padding:"9px 0", fontSize:13, color:C.sub, borderBottom:`1px solid ${C.border}` }}>
                <span>Service charge</span><span>₹{booking.jobTotal}</span>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", padding:"9px 0", fontSize:13, color:C.amber, fontWeight:700, borderBottom:`1px solid ${C.border}` }}>
                <span>🏷️ ProWorkers platform charge</span><span>+₹{booking.platformFee}</span>
              </div>
            </>
          )}
          <div style={{ display:"flex", justifyContent:"space-between", padding:"12px 0", fontWeight:900, color:C.amber, fontSize:15 }}>
            <span>Total Paid</span><span>₹{booking.total}</span>
          </div>
          </>)}
        </div>

        {/* User's rating if already done */}
        {booking.userRating && (
          <div style={{ margin:"0 20px", background:C.card2, borderRadius:14, padding:16, border:`1px solid ${C.amber}44` }}>
            <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:8 }}>YOUR RATING</div>
            <div style={{ color:C.amber, fontSize:22 }}>{"★".repeat(booking.userRating.stars)}{"☆".repeat(5-booking.userRating.stars)}</div>
            {booking.userRating.tags?.length>0 && <div style={{ color:C.sub, fontSize:12, marginTop:6 }}>{booking.userRating.tags.join(" · ")}</div>}
            {booking.userRating.remark && <div style={{ color:C.text, fontSize:13, marginTop:6, fontStyle:"italic" }}>"{booking.userRating.remark}"</div>}
          </div>
        )}

        {/* Rate button if not rated yet. Previously this required booking.paid,
            which meant a customer could never rate from My Bookings unless
            they'd gone through the in-app payment flow — e.g. cash jobs paid
            directly to the worker, or a booking left unpaid, would silently
            hide the rate button forever even though a real worker did the
            job. Rating is a separate concern from payment: all that's needed
            is a worker actually assigned, and the booking not cancelled. */}
        {!rated && booking.paid && booking.workerName && booking.status !== "cancelled" && !showRateForm && (
          <div style={{ padding:"16px 20px 0" }}>
            <button onClick={() => setShowRateForm(true)} style={{ width:"100%", padding:"13px 0", background:C.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>
              ⭐ Rate & Remark this Worker
            </button>
          </div>
        )}

        {/* Inline rating form */}
        {showRateForm && !rated && (
          <div style={{ margin:"16px 20px", background:C.card2, borderRadius:16, padding:18, border:`1px solid ${svc.color}44` }}>
            {rateErr && <div style={{ color:C.red, fontSize:13, marginBottom:10 }}>⚠️ {rateErr}</div>}
            <InlineRating C={C} svc={svc} workerName={booking.workerName} workerAvatar={booking.workerAvatar}
              onSubmit={async (r) => {
                try {
                  const res = await apiPost(`/bookings/${booking.id}/rating`, r);
                  const updated = normalizeBooking(res.booking);
                  booking.userRating = updated.userRating;
                  booking.status = updated.status;
                  setRated(true);
                  setShowRateForm(false);
                  setRateErr("");
                  if (onRated) onRated(updated);
                  return true;
                } catch (e) {
                  setRateErr(e.message || "Could not save rating. Please try again.");
                  return false;
                }
              }} compact />
          </div>
        )}

        {onRebook && booking.items?.length > 0 && ["completed","paid","cancelled"].includes(booking.status) && (
          <div style={{ padding:"16px 20px 0" }}>
            <button onClick={() => { onRebook(booking); onClose(); }} style={{ width:"100%", padding:"13px 0", background:C.green, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>🔁 Book again</button>
          </div>
        )}
        {/* Actions */}
        <div style={{ padding:"16px 20px 36px", display:"flex", gap:10, marginTop:8 }}>
          <button onClick={() => { onComplaint(booking); onClose(); }} style={{ flex:1, padding:"13px 0", background:`${C.red}18`, color:C.red, border:`1.5px solid ${C.red}33`, borderRadius:12, fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>⚠️ Complaint</button>
          <button onClick={onClose} style={{ flex:1, padding:"13px 0", background:C.card2, color:C.muted, border:`1.5px solid ${C.border}`, borderRadius:12, fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Booking Flow ──────────────────────────────────────────────────────────────
// Call + chat buttons shown to both sides once a worker is assigned
const telHref = ph => `tel:${String(ph || "").replace(/[^\d+]/g, "")}`;
function ContactBar({ phone, name, onChat, C }) {
  return (
    <div style={{ display:"flex", gap:8, marginTop:10 }}>
      {phone ? (
        <a href={telHref(phone)} style={{ flex:1, textAlign:"center", textDecoration:"none", background:`${C.green}22`, border:`1px solid ${C.green}66`, color:C.green, borderRadius:10, padding:"11px 0", fontWeight:800, fontSize:13 }}>📞 Call {name || ""}</a>
      ) : null}
      <button onClick={onChat} style={{ flex:1, background:`${C.blue}22`, border:`1px solid ${C.blue}66`, color:C.blue, borderRadius:10, padding:"11px 0", fontWeight:800, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>💬 Chat</button>
    </div>
  );
}

// In-app chat for one booking (customer <-> assigned worker)
function ChatModal({ booking, meRole, otherName, otherPhone, C, onClose }) {
  const [msgs, setMsgs] = useState([]);
  const [open, setOpen] = useState(true);
  const [text, setText] = useState("");
  const [err, setErr]   = useState("");
  const endRef = useRef(null), lastRef = useRef(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const q = lastRef.current ? `?after=${encodeURIComponent(lastRef.current)}` : "";
        const d = await apiGet(`/bookings/${booking.id}/messages${q}`);
        if (stop) return;
        setOpen(d.open);
        if (d.messages.length) {
          setMsgs(prev => { const ids = new Set(prev.map(m => m.id)); const add = d.messages.filter(m => !ids.has(m.id)); return add.length ? [...prev, ...add] : prev; });
          lastRef.current = d.messages[d.messages.length - 1].createdAt;
        }
      } catch {}
    };
    load(); const t = setInterval(load, 4000);
    return () => { stop = true; clearInterval(t); };
  }, [booking.id]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior:"smooth" }); }, [msgs.length]);
  async function send() {
    const v = text.trim(); if (!v) return;
    setErr(""); setText("");
    try {
      const r = await apiPost(`/bookings/${booking.id}/messages`, { text: v });
      setMsgs(prev => prev.some(m => m.id === r.message.id) ? prev : [...prev, r.message]);
    } catch (e) { setErr(e.message || "Could not send."); setText(v); }
  }
  const hhmm = d => new Date(d).toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" });
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:600, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background:C.card, borderRadius:"22px 22px 0 0", width:"100%", maxWidth:480, height:"82vh", display:"flex", flexDirection:"column", border:`1px solid ${C.border}` }}>
        <div style={{ padding:"14px 16px", display:"flex", alignItems:"center", gap:10, borderBottom:`1px solid ${C.border}` }}>
          <div style={{ flex:1 }}>
            <div style={{ color:C.text, fontWeight:900, fontSize:16 }}>💬 {otherName || (meRole === "customer" ? "Worker" : "Customer")}</div>
            {otherPhone && <div style={{ color:C.muted, fontSize:12, marginTop:2 }}>{otherPhone}</div>}
          </div>
          {otherPhone && <a href={telHref(otherPhone)} style={{ textDecoration:"none", background:`${C.green}22`, border:`1px solid ${C.green}66`, color:C.green, borderRadius:10, padding:"8px 12px", fontWeight:800, fontSize:13 }}>📞 Call</a>}
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.muted, fontSize:24, cursor:"pointer" }}>✕</button>
        </div>
        <div style={{ flex:1, overflowY:"auto", padding:"12px 14px" }}>
          {msgs.length === 0 && <div style={{ color:C.muted, fontSize:13, textAlign:"center", marginTop:40 }}>No messages yet. Say hello 👋</div>}
          {msgs.map(m => {
            const mine = m.senderRole === meRole;
            return (
              <div key={m.id} style={{ display:"flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom:8 }}>
                <div style={{ maxWidth:"78%", background: mine ? C.amber : C.card2, color: mine ? "#0D1117" : C.text, borderRadius:14, padding:"8px 12px", fontSize:14, lineHeight:1.4, wordBreak:"break-word" }}>
                  {m.text}
                  <div style={{ fontSize:10, opacity:0.6, marginTop:3, textAlign:"right" }}>{hhmm(m.createdAt)}</div>
                </div>
              </div>
            );
          })}
          <div ref={endRef}/>
        </div>
        {!open && <div style={{ color:C.muted, fontSize:12, textAlign:"center", padding:"8px 14px", borderTop:`1px solid ${C.border}` }}>Chat is closed for this booking.</div>}
        {err && <div style={{ color:C.red, fontSize:12, padding:"6px 14px 0" }}>⚠️ {err}</div>}
        <div style={{ display:"flex", gap:8, padding:"10px 12px 18px", borderTop: open ? `1px solid ${C.border}` : "none" }}>
          <input value={text} disabled={!open} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") send(); }} maxLength={500} placeholder={open ? "Type a message…" : "Chat closed"} style={{ flex:1, background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:12, padding:"12px 14px", fontSize:14, fontFamily:"inherit", outline:"none" }}/>
          <button onClick={send} disabled={!open || !text.trim()} style={{ background: open && text.trim() ? C.amber : C.card2, color: open && text.trim() ? "#0D1117" : C.muted, border:"none", borderRadius:12, padding:"0 18px", fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>Send</button>
        </div>
      </div>
    </div>
  );
}

// Worker: "I've arrived" only works within 200 m of the customer's address (the server checks it too)
function ArriveButton({ req, C, onTap }) {
  const [chk, setChk] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = () => apiGet(`/bookings/${req.id}/arrival-check`).then(d => { if (!stop) setChk(d); }).catch(() => {});
    load(); const t = setInterval(load, 10000);
    return () => { stop = true; clearInterval(t); };
  }, [req.id]);
  const ok = !!chk?.canArrive;
  const far = chk && !chk.canArrive && chk.distanceM != null;
  return (
    <div style={{ marginBottom:10 }}>
      <button onClick={() => ok && onTap()} disabled={!ok} style={{ width:"100%", padding:"14px 0", background: ok ? C.green : C.card2, color: ok ? "#0D1117" : C.muted, border: ok ? "none" : `1.5px solid ${C.border}`, borderRadius:12, fontWeight:800, fontSize:15, cursor: ok ? "pointer" : "not-allowed", fontFamily:"inherit" }}>
        📍 I've arrived
      </button>
      <div style={{ color:C.muted, fontSize:11.5, textAlign:"center", marginTop:6 }}>
        {!chk ? "Checking your distance…"
          : ok ? (chk.distanceM != null ? `You are ${chk.distanceM} m from the customer ✓` : "Tap when you reach the address")
          : far ? `You are ${chk.distanceM >= 1000 ? (chk.distanceM/1000).toFixed(1) + " km" : chk.distanceM + " m"} away. Come within ${chk.radiusM || 200} m to tap this.`
          : "We can't see your location yet. Keep the app open with location sharing on."}
      </div>
    </div>
  );
}

// Live tracking card for the customer: the worker's position and how far they have come since accepting
function LiveTrack({ booking, C, svc }) {
  const [live, setLive] = useState(null);
  const mapEl = useRef(null), mapObj = useRef(null), wMark = useRef(null);
  const on = ["on_way"].includes(booking.status);
  useEffect(() => {
    if (!on) return;
    let stop = false;
    const load = () => apiGet(`/bookings/${booking.id}/live`).then(d => { if (!stop) setLive(d); }).catch(() => {});
    load(); const t = setInterval(load, 8000);
    return () => { stop = true; clearInterval(t); };
  }, [on, booking.id]);
  useEffect(() => {
    if (!on || !live?.worker || !mapEl.current) return;
    const dot = (color) => L.divIcon({ html:`<div style="width:16px;height:16px;background:${color};border-radius:50%;border:3px solid #fff;box-shadow:0 1px 6px #0009"></div>`, iconSize:[16,16], iconAnchor:[8,8], className:"" });
    if (!mapObj.current) {
      const m = L.map(mapEl.current, { zoomControl:false, attributionControl:false, dragging:true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19 }).addTo(m);
      if (live.pin) L.marker([live.pin.lat, live.pin.lng], { icon: dot("#E5484D") }).addTo(m);
      wMark.current = L.marker([live.worker.lat, live.worker.lng], { icon: dot("#2F81F7"), zIndexOffset:500 }).addTo(m);
      mapObj.current = m;
    } else wMark.current.setLatLng([live.worker.lat, live.worker.lng]);
    const pts = [[live.worker.lat, live.worker.lng]]; if (live.pin) pts.push([live.pin.lat, live.pin.lng]);
    mapObj.current.fitBounds(pts, { padding:[30,30], maxZoom:16 });
  }, [live, on]);
  useEffect(() => () => { if (mapObj.current) { mapObj.current.remove(); mapObj.current = null; } }, []);
  if (booking.arrivedAt) return (
    <div style={{ background:`${C.green}18`, border:`1px solid ${C.green}55`, borderRadius:14, padding:"14px 16px", marginBottom:14, textAlign:"center" }}>
      <div style={{ color:C.green, fontWeight:900, fontSize:16 }}>📍 {booking.workerName || "Your worker"} has arrived</div>
      <div style={{ color:C.muted, fontSize:12, marginTop:3 }}>Arrived at {new Date(booking.arrivedAt).toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" })}</div>
    </div>
  );
  if (!on) return null;
  const startKm = live?.startKm, rem = live?.remainingKm;
  const pct = startKm > 0 && rem != null ? Math.max(0, Math.min(100, Math.round(((startKm - rem) / startKm) * 100))) : 0;
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:14, marginBottom:14 }}>
      <div style={{ color:C.text, fontWeight:800, fontSize:14 }}>🚗 {booking.workerName || "Your worker"} is on the way</div>
      {live?.worker ? (
        <>
          <div ref={mapEl} style={{ height:170, borderRadius:12, marginTop:10, overflow:"hidden", background:C.card2 }}/>
          <div style={{ display:"flex", justifyContent:"space-between", color:C.muted, fontSize:12, marginTop:10 }}>
            <span>{rem != null ? `${rem} km away` : ""}</span>
            <span>{startKm > 0 && rem != null ? `${Math.max(0, Math.round((startKm - rem) * 10) / 10)} of ${startKm} km travelled` : ""}</span>
          </div>
          {startKm > 0 && rem != null && <div style={{ height:6, background:C.card2, borderRadius:3, marginTop:6 }}><div style={{ width:`${pct}%`, height:6, background:svc.color, borderRadius:3, transition:"width .6s" }}/></div>}
          <div style={{ color:C.muted, fontSize:11, marginTop:8 }}>Blue = worker, red = your address. Updates while the worker's app is open.</div>
          <div style={{ color:live.cancelFeeNow > 0 ? C.amber : C.muted, fontSize:12, fontWeight:700, marginTop:6 }}>
            {live.cancelFeeNow > 0 ? `If you cancel now: ₹${live.cancelFeeNow} travel fee` : "If you cancel now: no fee (first 1 km is free)"}
          </div>
        </>
      ) : (
        <div style={{ color:C.muted, fontSize:12, marginTop:6 }}>Waiting for the worker's location… (they may not have shared it)</div>
      )}
    </div>
  );
}

function BookingFlow({ onBack, onBooked, C, user, prefill, resume }) {
  const [step,         setStep]         = useState(resume ? 4 : 1);
  const [address,      setAddress]      = useState(prefill?.address || "");
  const [coords,       setCoords]       = useState(prefill?.coords || null);
  const [showMap,      setShowMap]      = useState(false);
  const [wtype,        setWtype]        = useState(SERVICES[(resume || prefill)?.serviceType] ? (resume || prefill).serviceType : "electrician");
  const [cart,         setCart]         = useState(() => {
    // "Book again": bring back the same jobs, but only ones that still exist at today's price
    const svcJobs = SERVICES[prefill?.serviceType]?.jobs || [];
    return (prefill?.items || []).map(i => { const j = svcJobs.find(x => x.id === i.id); return j ? { ...j, qty: Math.max(1, Math.min(i.qty || 1, j.unit === "hr" ? 12 : 99)) } : null; }).filter(Boolean);
  });
  const [custProb,     setCustProb]     = useState("");
  const [custPrc,      setCustPrc]      = useState("");
  const [lockedWorker, setLockedWorker] = useState(null);
  const [worker,       setWorker]       = useState(null);
  const [booking,      setBooking]      = useState(resume ? { ...resume, _fetchedAt: Date.now() } : null);
  const [showPay,      setShowPay]      = useState(false);
  const [showChat,     setShowChat]     = useState(false);
  const [workerCounts, setWorkerCounts] = useState({ electrician:0, plumber:0, labour:0 });
  const [checking,     setChecking]     = useState(false);
  const [unavailable,  setUnavailable]  = useState(false);
  const [waitSecs,     setWaitSecs]     = useState(0);
  const [submitErr,    setSubmitErr]    = useState("");
  const [when,         setWhen]         = useState("now");      // "now" | "later"
  const [schedDate,    setSchedDate]    = useState("");
  const [schedTime,    setSchedTime]    = useState("");
  const [favs,         setFavs]         = useState([]);
  const [preferred,    setPreferred]    = useState("");
  const [favIds,       setFavIds]       = useState([]);

  const svc     = SERVICES[wtype];
  const custAmt = custProb && custPrc ? (parseInt(custPrc)||0) : 0;
  const jobTotal = cart.reduce((s,i) => s+i.price*(i.qty||1), 0) + custAmt;
  // A cart made only of trial jobs has no platform fee (the server applies the same rule)
  const isTrialCart = cart.length > 0 && !custAmt && cart.every(i => TRIAL_JOB_IDS.includes(i.id));
  const PLATFORM_MARKUP = isTrialCart ? 0 : customerFeeFor(jobTotal);   // ₹0 / ₹10 / ₹20 by order value
  const total    = jobTotal + PLATFORM_MARKUP;

  // Real "X online" counts per service type — no fake numbers.
  useEffect(() => {
    apiGet("/workers/counts").then(setWorkerCounts).catch(() => {});
    apiGet("/customer/favorites").then(r => { setFavs(r.favorites || []); setFavIds((r.favorites || []).map(f => String(f.id))); }).catch(() => {});
  }, []);

  // Date + time the customer picked for "later" (as a real Date), or null
  const schedAt = when === "later" && schedDate && schedTime ? new Date(`${schedDate}T${schedTime}`) : null;
  const schedOk = !!schedAt && !isNaN(schedAt) && schedAt - Date.now() >= 90*60*1000 && schedAt - Date.now() <= 7*24*3600*1000;
  const fmtWhen = d => new Date(d).toLocaleString("en-IN", { weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" });
  const pad2 = n => String(n).padStart(2, "0");
  const dateStr = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  async function toggleFav(workerId, want) {
    try {
      const r = await apiPost("/customer/favorites", { workerId, favorite: want });
      setFavIds((r.favoriteWorkerIds || []).map(String));
      apiGet("/customer/favorites").then(x => setFavs(x.favorites || [])).catch(() => {});
    } catch (e) { setSubmitErr(e.message || "Could not update favourites."); }
  }

  function setQty(job, delta) {
    setCart(prev => {
      const ex = prev.find(x => x.id===job.id);
      if (!ex && delta>0) return [...prev, {...job, qty:1}];
      if (ex) {
        const nq = Math.min((ex.qty||1)+delta, ex.unit === "hr" ? 12 : 99);
        if (nq<=0) return prev.filter(x => x.id!==job.id);
        return prev.map(x => x.id===job.id ? {...x, qty:nq} : x);
      }
      return prev;
    });
  }

  // Look for a genuinely available real worker before moving to Confirm.
  async function goToStep3() {
    setUnavailable(false);
    setChecking(true);
    try {
      const data = await apiGet(`/workers/check/${wtype}`);
      setLockedWorker(data.worker);
      setStep(3);
    } catch (e) {
      setUnavailable(true);
    }
    setChecking(false);
  }

  // Create the booking for real — backend re-validates worker availability
  // and computes the +₹20 / −₹15 charges server-side.
  async function confirmBooking() {
    setSubmitErr("");
    setChecking(true);
    const items = [...cart, ...(custProb?[{id:"cust",name:`Other: ${custProb}`,price:custAmt,qty:1}]:[])];
    const now = new Date();
    if (when === "later" && !schedOk) { setSubmitErr("Pick a time between 90 minutes and 7 days from now."); setChecking(false); return; }
    const at = when === "later" ? schedAt : null;
    try {
      const res = await apiPost("/bookings", {
        ...(at ? { scheduledFor: at.toISOString() } : {}),
        ...(preferred ? { preferredWorkerId: preferred } : {}),
        customerId: user.id,
        customerName: user.name,
        customerPhone: user.phone,
        serviceType: wtype,
        items,
        address,
        coords,
        date: (at || now).toLocaleDateString("en-IN"),
        time: (at || now).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"}),
      });
      const w = res.worker;
      setWorker(w);
      setBooking(normalizeBooking(res.booking));
      setWaitSecs(0);
      setStep(4);
    } catch (e) {
      if (e.message === "We Are Currently Unavailable") {
        setUnavailable(true);
        setStep(2);
      } else {
        setSubmitErr(e.message || "Could not create booking. Please try again.");
      }
    }
    setChecking(false);
  }

  // Poll for worker acceptance while on Step 4 and no worker is assigned yet.
  // The booking is created as "pending_acceptance" with no workerName — once a
  // worker taps Accept on their end, the backend updates the booking's status
  // and worker fields, but this screen never knew because it only set `booking`
  // once, right after creation. Poll the customer's bookings every few seconds
  // and refresh local state as soon as a worker shows up.
  useEffect(() => {
    if (step !== 4 || !booking || booking.status === "cancelled" || (booking.status === "completed" && booking.paid)) return;
    let cancelled = false;
    const hadWorker = !!booking.workerName;
    const interval = setInterval(async () => {
      try {
        const list = await apiGet(`/bookings/customer/${user.id}`);
        if (cancelled) return;
        const fresh = (list || []).find(b => (b._id || b.id) === booking.id);
        if (fresh) {
          const updated = normalizeBooking(fresh);
          setBooking(updated);
          // Note: intentionally NOT calling onBooked() here — that would push a
          // duplicate entry into the history list and jump the customer away to
          // the History tab while they're still looking at this screen. The
          // App-level loadBookings() poll (every 8s) already keeps the History
          // list in sync independently.
          if (updated.workerName && !hadWorker) {
            pushNotif("Worker Assigned ✅", `${updated.workerName} accepted your booking!`);
          }
        }
      } catch (e) {
        // Silent — just try again on the next tick.
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [step, booking?.id, booking?.workerName, booking?.status, booking?.paid, user.id]);

  // Elapsed-time ticker for the "waiting for acceptance" screen.
  useEffect(() => {
    if (step !== 4 || !booking || booking.workerName) return;
    const t = setInterval(() => setWaitSecs(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [step, booking?.id, booking?.workerName]);

  async function submitUtrForBooking(method, label, utr) {
    const updated = await apiSubmitUtr(booking.id, method, label, utr);
    setBooking(updated);
    onBooked(updated);
    pushNotif("Payment Submitted ⏳", `₹${updated.total} — waiting for admin to verify your UTR.`);
  }

  async function handlePay(method, label, rating) {
    try {
      // IMPORTANT: only set the `paid` flag here — never overwrite `status`.
      // `status` tracks the worker's real job progress (assigned/on_way/in_progress/completed).
      // Forcing it to "paid" on early payment used to hide the booking from the worker's
      // request queue, which is why workers couldn't see the real job status.
      //
      // Cash is a special case: money hasn't actually changed hands yet just because
      // the customer picked "Cash on Completion" — it changes hands later, in person,
      // and only the worker can confirm it really happened. So for cash we record the
      // *choice* (paymentMethod) but leave `paid:false` and `cashConfirmed:null` until
      // the worker confirms receipt. Only then does the app show payment as done.
      const isCash = method === "cash";
      // UPI: the UTR was already submitted (and the booking is waiting for admin
      // verification) by submitUtrForBooking. Here we only save the rating, if any.
      if (method.startsWith("upi_")) {
        if (rating) await apiPatch(`/bookings/${booking.id}`, { userRating: rating });
        const fresh = normalizeBooking(await apiGet(`/bookings/${booking.id}`));
        setBooking(fresh); onBooked(fresh);
        setShowPay(false);
        return;
      }
      const updatedPayload = isCash
        ? { paymentMethod: method, paymentLabel: label, paid: false, cashConfirmed: null }
        : { paid: true, paymentMethod: method, paymentLabel: label };
      if (rating) updatedPayload.userRating = rating;
      const res = await apiPatch(`/bookings/${booking.id}`, updatedPayload);
      const updated = normalizeBooking(res.booking);
      setBooking(updated);
      onBooked(updated);
      setShowPay(false);
      if (isCash) {
        pushNotif("Cash Payment Selected", `₹${updated.total} due in cash — you'll be marked as paid once the worker confirms they received it.`);
      } else {
        pushNotif("Payment Done ✅", `₹${updated.total} paid via ${label}. Thank you!`);
      }
    } catch (e) {
      setSubmitErr(e.message || "Payment failed. Please try again.");
      setShowPay(false);
    }
  }

  async function cancelBooking() {
    let fee = 0;
    if (booking.status === "on_way") { try { fee = (await apiGet(`/bookings/${booking.id}/live`)).cancelFeeNow || 0; } catch {} }
    const msg = fee > 0
      ? `${booking.workerName || "The worker"} has already travelled towards you. Cancelling now costs a ₹${fee} travel fee (₹2 per km travelled, first 1 km free), paid by UPI and credited to the worker. Cancel anyway?`
      : "Cancel this booking?";
    if (!window.confirm(msg)) return;
    try {
      const res = await apiPatch(`/bookings/${booking.id}`, { status: "cancelled" });
      const upd = normalizeBooking(res.booking);
      setBooking(upd);
      pushNotif("Booking cancelled", upd.cancelFee > 0 ? `Please pay the ₹${upd.cancelFee} travel fee.` : "Your booking was cancelled.");
    } catch { alert("Could not cancel. Please try again."); }
  }

  const I = inp(C);

  function StepBar() {
    return (
      <div style={{ display:"flex", gap:6, marginBottom:24 }}>
        {["Location","Services","Confirm","Done"].map((s,i) => (
          <div key={s} style={{ flex:1, textAlign:"center" }}>
            <div style={{ height:3, borderRadius:2, background:step>i?svc.color:C.border, marginBottom:4 }}/>
            <span style={{ fontSize:10, color:step>i?svc.color:C.muted, fontWeight:700 }}>{s}</span>
          </div>
        ))}
      </div>
    );
  }

  if (showMap) {
    return <FullMapScreen onConfirm={(addr,c) => { setAddress(addr); setCoords(c); setShowMap(false); }} onClose={() => setShowMap(false)} C={C}/>;
  }

  // Step 1 — Location
  if (step===1) {
    return (
      <div style={{ padding:20, maxWidth:480, margin:"0 auto" }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:14, marginBottom:18, padding:0 }}>← Back</button>
        <StepBar/>
        <h2 style={{ color:C.text, margin:"0 0 4px", fontWeight:900, fontSize:22 }}>Book a Worker</h2>
        <p style={{ color:C.muted, fontSize:13, marginBottom:22 }}>Where are you? What do you need?</p>

        <div style={{ marginBottom:18 }}>
          <label style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, display:"block", marginBottom:8 }}>📍 YOUR ADDRESS</label>
          <button onClick={() => setShowMap(true)} style={{ width:"100%", padding:"14px 16px", marginBottom:10, borderRadius:12, cursor:"pointer", fontFamily:"inherit", fontWeight:800, fontSize:14, textAlign:"left",
            background: coords ? C.green+"18" : C.card2, color: coords ? C.green : C.text, border:`1.5px solid ${coords ? C.green : svc.color}` }}>
            {coords ? "✅ Location pinned. Tap to change" : "📍 Pick your location on the map (optional)"}
          </button>
          <input style={I} placeholder="House no., Street, Area, Surat" value={address} onChange={e=>setAddress(e.target.value)}/>
          {!coords && <div style={{ color:C.muted, fontSize:11, marginTop:6 }}>Map pin is optional. Type your full address below. A pin just helps the worker navigate straight to you.</div>}
        </div>

        <div style={{ marginBottom:28 }}>
          <label style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, display:"block", marginBottom:12 }}>👷 WORKER TYPE</label>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
            {Object.entries(SERVICES).map(([k,v]) => {
              const cnt = workerCounts[k] || 0;
              const busyAll = cnt > 0 && (workerCounts.free?.[k] ?? cnt) === 0;
              return (
                <div key={k} onClick={() => setWtype(k)} style={{ padding:"16px 8px", borderRadius:14, textAlign:"center", cursor:"pointer", border:`2px solid ${wtype===k?v.color:C.border}`, background:wtype===k?`${v.color}15`:C.card2 }}>
                  <div style={{ fontSize:28 }}>{v.icon}</div>
                  <div style={{ fontSize:11, fontWeight:700, color:wtype===k?v.color:C.muted, marginTop:5 }}>{v.label}</div>
                  <div style={{ color: busyAll ? C.amber : C.green, fontSize:10, marginTop:3 }}>● {busyAll ? "busy now" : `${cnt} online`}</div>
                </div>
              );
            })}
          </div>
        </div>

        <button onClick={() => { if(address.trim()) setStep(2); }} style={{ width:"100%", padding:"16px 0", background:address.trim()?svc.color:C.border, color:address.trim()?"#0D1117":C.muted, border:"none", borderRadius:14, fontWeight:800, fontSize:16, cursor:address.trim()?"pointer":"not-allowed", fontFamily:"inherit" }}>
          Find Workers →
        </button>
      </div>
    );
  }

  // Step 2 — Services + Cart
  if (step===2) {
    return (
      <div style={{ padding:20, maxWidth:480, margin:"0 auto", paddingBottom:130 }}>
        <button onClick={() => setStep(1)} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:14, marginBottom:18, padding:0 }}>← Back</button>
        <StepBar/>
        <h2 style={{ color:C.text, margin:"0 0 4px", fontWeight:900, fontSize:22 }}>{svc.icon} {svc.label}</h2>
        <p style={{ color:C.muted, fontSize:13, marginBottom:18 }}>Add the services you need.</p>

        {svc.jobs.map(job => {
          const qty = cart.find(x=>x.id===job.id)?.qty || 0;
          return (
            <div key={job.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 16px", background:C.card2, borderRadius:12, marginBottom:8, border:`1.5px solid ${qty>0?svc.color:C.border}` }}>
              <div style={{ flex:1 }}>
                <div style={{ color:C.text, fontWeight:600, fontSize:14 }}>{job.name}</div>
                <div style={{ color:svc.color, fontSize:15, fontWeight:800, marginTop:2 }}>₹{job.price}{job.unit === "hr" ? <span style={{ fontSize:11, fontWeight:700, color:C.muted }}> per hour</span> : null}</div>
              </div>
              {qty===0 ? (
                <button onClick={() => setQty(job,1)} style={{ background:`${svc.color}18`, color:svc.color, border:`1.5px solid ${svc.color}44`, borderRadius:10, padding:"8px 18px", cursor:"pointer", fontWeight:800, fontSize:18, fontFamily:"inherit" }}>+</button>
              ) : (
                <div style={{ display:"flex", alignItems:"center" }}>
                  <button onClick={() => setQty(job,-1)} style={{ width:34, height:34, borderRadius:"8px 0 0 8px", background:`${C.red}18`, color:C.red, border:`1.5px solid ${C.red}33`, cursor:"pointer", fontWeight:800, fontSize:20, display:"flex", alignItems:"center", justifyContent:"center" }}>−</button>
                  <div style={{ width:36, height:34, background:C.card, border:`1.5px solid ${svc.color}`, borderLeft:"none", borderRight:"none", display:"flex", alignItems:"center", justifyContent:"center", color:C.text, fontWeight:800, fontSize:job.unit === "hr" ? 12 : 15, width: job.unit === "hr" ? 52 : 36 }}>{job.unit === "hr" ? `${qty} hr` : qty}</div>
                  <button onClick={() => setQty(job,1)} style={{ width:34, height:34, borderRadius:"0 8px 8px 0", background:`${svc.color}18`, color:svc.color, border:`1.5px solid ${svc.color}44`, cursor:"pointer", fontWeight:800, fontSize:20, display:"flex", alignItems:"center", justifyContent:"center" }}>+</button>
                </div>
              )}
            </div>
          );
        })}

        <div style={{ background:C.card, border:`1.5px solid ${C.border}`, borderRadius:16, padding:18, marginTop:10, marginBottom:16 }}>
          <div style={{ color:C.amber, fontWeight:800, fontSize:14, marginBottom:12 }}>➕ Other Problem</div>
          <input style={{ ...I, marginBottom:10 }} placeholder="Describe your issue…" value={custProb} onChange={e=>setCustProb(e.target.value)}/>
          <input style={I} placeholder="Your suggested price ₹" value={custPrc} onChange={e=>setCustPrc(e.target.value)} type="number"/>
          {custProb && <div style={{ color:C.muted, fontSize:11, marginTop:8 }}>⚠️ Worker confirms final price on arrival.</div>}
        </div>

        {unavailable && (
          <div style={{ background:`${C.red}18`, border:`1.5px solid ${C.red}44`, borderRadius:14, padding:16, marginTop:10, marginBottom:6, textAlign:"center" }}>
            <div style={{ fontSize:28, marginBottom:6 }}>😔</div>
            <div style={{ color:C.red, fontWeight:800, fontSize:15 }}>We Are Currently Unavailable</div>
            <div style={{ color:C.muted, fontSize:12, marginTop:4 }}>No {svc.label.toLowerCase()} is online right now. Please try again shortly.</div>
            <button onClick={() => { setUnavailable(false); setLockedWorker(null); setWhen("later"); setStep(3); }} style={{ marginTop:12, background:svc.color, color:"#0D1117", border:"none", borderRadius:10, padding:"10px 16px", fontWeight:800, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>📅 Book for later instead</button>
          </div>
        )}

        {(cart.length>0||custProb) && (
          <div style={{ position:"fixed", bottom:70, left:0, right:0, background:svc.color, padding:"16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", zIndex:60 }}>
            <div style={{ color:"#0D1117" }}>
              <div style={{ fontWeight:900, fontSize:16 }}>{cart.length+(custProb?1:0)} item{cart.length+(custProb?1:0)!==1?"s":""} · ₹{total}</div>
              <div style={{ fontSize:11, opacity:0.75 }}>Tap to review</div>
            </div>
            <button onClick={goToStep3} disabled={checking} style={{ background:"#0D1117", color:svc.color, border:"none", borderRadius:10, padding:"10px 20px", fontWeight:800, fontSize:14, cursor:checking?"default":"pointer", opacity:checking?0.6:1, fontFamily:"inherit" }}>
              {checking ? "Checking…" : "Next →"}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Step 3 — Confirm (lockedWorker never changes now)
  if (step===3) {
    return (
      <div style={{ padding:20, maxWidth:480, margin:"0 auto" }}>
        <button onClick={() => setStep(2)} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:14, marginBottom:18, padding:0 }}>← Back</button>
        <StepBar/>
        <h2 style={{ color:C.text, margin:"0 0 4px", fontWeight:900, fontSize:22 }}>Confirm Booking</h2>
        <p style={{ color:C.muted, fontSize:13, marginBottom:20 }}>Review before we assign.</p>

        <div style={{ background:C.card2, border:`1px solid ${C.border}`, borderRadius:14, padding:16, marginBottom:12 }}>
          <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:6 }}>📍 YOUR LOCATION</div>
          <div style={{ color:C.text, fontSize:14 }}>{address}</div>
        </div>

        <div style={{ background:C.card2, border:`1px solid ${C.border}`, borderRadius:14, padding:16, marginBottom:12 }}>
          <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:10 }}>🛒 SERVICES</div>
          {cart.map(i => (
            <div key={i.id} style={{ display:"flex", justifyContent:"space-between", color:C.sub, fontSize:13, marginBottom:6 }}>
              <span>{i.name}{qtyText(i) ? ` · ${qtyText(i)}` : ""}</span><span style={{ color:svc.color, fontWeight:700 }}>₹{i.price*i.qty}</span>
            </div>
          ))}
          {custProb && <div style={{ display:"flex", justifyContent:"space-between", color:C.sub, fontSize:13, marginBottom:6 }}><span>Other: {custProb.slice(0,22)}</span><span style={{ color:svc.color, fontWeight:700 }}>₹{custPrc||"TBD"}</span></div>}
          <div style={{ borderTop:`1px solid ${C.border}`, marginTop:10, paddingTop:10, display:"flex", justifyContent:"space-between", color:C.text, fontSize:13, fontWeight:700 }}>
            <span>Service charge</span><span>₹{jobTotal}</span>
          </div>
          {PLATFORM_MARKUP > 0 ? (
            <div style={{ display:"flex", justifyContent:"space-between", color:C.amber, fontSize:13, fontWeight:700, marginTop:6 }}>
              <span>🏷️ ProWorkers platform charge</span><span>+₹{PLATFORM_MARKUP}</span>
            </div>
          ) : !isTrialCart && (
            <div style={{ display:"flex", justifyContent:"space-between", color:C.green, fontSize:13, fontWeight:700, marginTop:6 }}>
              <span>🏷️ ProWorkers platform charge</span><span>₹0 (free under ₹400)</span>
            </div>
          )}
          <div style={{ borderTop:`1px solid ${C.border}`, marginTop:10, paddingTop:10, display:"flex", justifyContent:"space-between", fontWeight:900, color:C.amber, fontSize:16 }}>
            <span>Total to pay</span><span>₹{total}</span>
          </div>
          {PLATFORM_MARKUP > 0 && <div style={{ color:C.muted, fontSize:11, marginTop:8, lineHeight:1.5 }}>The ₹{PLATFORM_MARKUP} platform charge is paid to ProWorkers (not to the worker). It covers verified workers, secure payment and support. The worker receives the service charge.</div>}
        </div>

        <div style={{ background:C.card2, border:`1px solid ${C.border}`, borderRadius:14, padding:16, marginBottom:12 }}>
          <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:10 }}>🕒 WHEN DO YOU NEED THE WORKER?</div>
          <div style={{ display:"flex", gap:8 }}>
            {[["now","⚡ Now"],["later","📅 Later"]].map(([k,l]) => (
              <button key={k} onClick={() => { setWhen(k); setSubmitErr(""); }} style={{ flex:1, padding:"10px 0", borderRadius:10, border:`1.5px solid ${when===k?svc.color:C.border}`, background:when===k?`${svc.color}22`:"transparent", color:when===k?svc.color:C.sub, fontWeight:800, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>{l}</button>
            ))}
          </div>
          {when==="later" && (
            <div style={{ marginTop:12 }}>
              <div style={{ display:"flex", gap:8 }}>
                <input type="date" value={schedDate} min={dateStr(new Date())} max={dateStr(new Date(Date.now()+7*24*3600*1000))} onChange={e => setSchedDate(e.target.value)} style={{ flex:1, minWidth:0, padding:"10px 8px", borderRadius:10, border:`1px solid ${C.border}`, background:C.card, color:C.text, fontFamily:"inherit", fontSize:14 }}/>
                <input type="time" value={schedTime} onChange={e => setSchedTime(e.target.value)} style={{ flex:1, minWidth:0, padding:"10px 8px", borderRadius:10, border:`1px solid ${C.border}`, background:C.card, color:C.text, fontFamily:"inherit", fontSize:14 }}/>
              </div>
              <div style={{ color: schedAt && !schedOk ? C.red : C.muted, fontSize:12, marginTop:8, lineHeight:1.5 }}>
                {schedAt && !schedOk ? "Pick a time between 90 minutes and 7 days from now." : schedOk ? `We'll start looking for a worker 1 hour before ${fmtWhen(schedAt)}.` : "Pick a day and time. We start looking for a worker 1 hour before."}
              </div>
            </div>
          )}
        </div>

        {favs.filter(f => f.workerType === wtype).length > 0 && (
          <div style={{ background:C.card2, border:`1px solid ${C.border}`, borderRadius:14, padding:16, marginBottom:12 }}>
            <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:10 }}>❤️ ASK MY FAVOURITE FIRST</div>
            <select value={preferred} onChange={e => setPreferred(e.target.value)} style={{ width:"100%", padding:"10px 8px", borderRadius:10, border:`1px solid ${C.border}`, background:C.card, color:C.text, fontFamily:"inherit", fontSize:14 }}>
              <option value="">Anyone nearby</option>
              {favs.filter(f => f.workerType === wtype).map(f => <option key={f.id} value={f.id}>{f.name}{f.isOnline ? " · online" : " · offline"}</option>)}
            </select>
            <div style={{ color:C.muted, fontSize:11, marginTop:6 }}>They get your request first. If they don't accept, others can.</div>
          </div>
        )}

        {lockedWorker && when==="now" && (
          <div style={{ background:C.card2, border:`1.5px solid ${svc.color}33`, borderRadius:14, padding:"14px 16px", marginBottom:24, display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:22 }}>{svc.icon}</span>
            <div>
              <div style={{ color:C.text, fontWeight:800, fontSize:14 }}>
                {workerCounts[wtype] > 1 ? `${workerCounts[wtype]} ${svc.label.toLowerCase()}s are online nearby` : `A ${svc.label.toLowerCase()} is online nearby`}
              </div>
              <div style={{ color:C.muted, fontSize:12, marginTop:2 }}>
                We'll notify all of them the moment you book — whoever accepts first gets your job.
              </div>
            </div>
          </div>
        )}

        {submitErr && (
          <div style={{ background:`${C.red}18`, border:`1.5px solid ${C.red}44`, borderRadius:12, padding:14, marginBottom:16, color:C.red, fontSize:13, fontWeight:600, textAlign:"center" }}>
            ⚠️ {submitErr}
          </div>
        )}

        <button onClick={confirmBooking} disabled={checking} style={{ width:"100%", padding:"16px 0", background:svc.color, color:"#0D1117", border:"none", borderRadius:14, fontWeight:800, fontSize:16, cursor:checking?"default":"pointer", opacity:checking?0.7:1, fontFamily:"inherit" }}>
          {checking ? "Booking…" : when==="later" ? "📅 Confirm and Schedule" : "✅ Confirm and Book"}
        </button>
      </div>
    );
  }

  // Step 4 — Waiting for worker confirmation, then Assigned
  // NOTE: previously this required `worker && booking`, but the booking-create
  // response never includes a `worker` (correctly — no one has accepted yet in
  // the broadcast model), so `worker` was always undefined and this whole
  // screen silently rendered nothing (a blank page). Only `booking` is needed.
  if (step===4 && booking) {
    const mm = String(Math.floor(waitSecs/60)).padStart(2,"0");
    const ss = String(waitSecs%60).padStart(2,"0");
    return (
      <div style={{ padding:20, maxWidth:480, margin:"0 auto" }}>
        <style>{`
          @keyframes pt-pulse-ring { 0%{ transform:scale(0.9); opacity:0.7; } 70%{ transform:scale(1.35); opacity:0; } 100%{ opacity:0; } }
          @keyframes pt-pop-in { 0%{ transform:scale(0.85); opacity:0; } 100%{ transform:scale(1); opacity:1; } }
        `}</style>
        <StepBar/>
        <div style={{ textAlign:"center", padding:"14px 0 4px" }}>
          <span style={{
            display:"inline-block", padding:"5px 14px", borderRadius:20, fontSize:11.5, fontWeight:800, letterSpacing:0.5,
            background: booking.status==="cancelled" ? `${C.red}22` : booking.workerName ? `${C.green}22` : `${C.amber}22`,
            color: booking.status==="cancelled" ? C.red : booking.workerName ? C.green : C.amber,
          }}>
            {booking.status==="cancelled" ? "● CANCELLED" : booking.workerName ? "● ACCEPTED" : "● PENDING"}
          </span>
        </div>
        <div style={{ textAlign:"center", padding:"10px 0 22px" }}>
          <div style={{ fontSize:52 }}>{booking.status==="cancelled" && !booking.paid ? "❌" : booking.paid ? "💸" : (booking.paymentMethod==="cash"||booking.paymentStatus==="pending_verification") ? "⏳" : booking.workerName ? "🎉" : "🔍"}</div>
          <h2 style={{ color:booking.paid?C.green:booking.status==="cancelled"?C.red:C.amber, margin:"10px 0 4px", fontWeight:900, fontSize:22 }}>
            {booking.paid ? "Payment Done!"
              : booking.status==="cancelled" ? "Booking Cancelled"
              : booking.paymentMethod==="cash" ? "Cash Payment Selected"
              : booking.paymentStatus==="pending_verification" ? "Payment Submitted"
              : booking.workerName ? "Worker Confirmed Your Job!" : "Waiting for Worker Confirmation"}
          </h2>
          <p style={{ color:C.muted, fontSize:13 }}>
            {booking.status==="cancelled"
              ? (booking.cancelFee > 0 ? `${booking.workerName || "The worker"} had already travelled towards you. Travel fee: ₹${booking.cancelFee} (₹2 per km after the first km).` : "Your booking was cancelled. No charge.")
              : booking.paymentMethod==="cash" && !booking.paid
              ? `Pay ₹${booking.total} in cash to ${booking.workerName||"the worker"}. It shows as paid once they confirm.`
              : booking.paymentStatus==="pending_verification" && !booking.paid
              ? "We'll mark it paid as soon as your payment is verified."
              : booking.workerName
              ? <span>Booking <span style={{ color:C.amber }}>#{booking.id}</span></span>
              : "This screen updates automatically the moment someone accepts."}
          </p>
          {!booking.workerName && !booking.paid && booking.status!=="cancelled" && (() => {
            // Seconds left of the "nearby workers first" window, counted from when the server told us
            const startLeft = booking.nearbySecondsLeft;
            const left = booking.searchPhase === "nearby" && startLeft != null ? Math.max(0, startLeft - Math.floor((Date.now() - (booking._fetchedAt || Date.now())) / 1000)) : 0;
            const near = booking.searchPhase === "nearby" && left > 0;
            const wide = booking.searchPhase === "wide" || (booking.searchPhase === "nearby" && left === 0);
            if (!near && !wide) return null;
            return (
              <div style={{ margin:"4px auto 0", maxWidth:300, background: near ? `${C.green}18` : `${C.amber}18`, border:`1px solid ${near ? C.green : C.amber}55`, borderRadius:14, padding:"10px 14px" }}>
                <div style={{ color: near ? C.green : C.amber, fontWeight:800, fontSize:14 }}>{near ? "📍 Finding nearby workers…" : "🔎 Searching a wider area…"}</div>
                {near && <div style={{ color:C.muted, fontSize:12, marginTop:3 }}>Workers within 3 km see your request first · {Math.floor(left/60)}:{String(left%60).padStart(2,"0")}</div>}
                {wide && <div style={{ color:C.muted, fontSize:12, marginTop:3 }}>Your request is now open to all online workers.</div>}
              </div>
            );
          })()}
        </div>

        {booking.scheduledFor && !booking.released && !booking.workerName && booking.status!=="cancelled" && (
          <div style={{ background:`${C.amber}18`, border:`1.5px solid ${C.amber}55`, borderRadius:16, padding:16, marginBottom:14, textAlign:"center" }}>
            <div style={{ color:C.amber, fontWeight:800, fontSize:15 }}>📅 Scheduled for {fmtWhen(booking.scheduledFor)}</div>
            <div style={{ color:C.muted, fontSize:12, marginTop:4, lineHeight:1.5 }}>We'll start looking for a worker 1 hour before. You'll get a notification when someone accepts. You can cancel any time for free before then.</div>
          </div>
        )}

        {booking.status==="cancelled" ? null : booking.workerName ? (
          <div style={{ background:C.card, border:`2px solid ${svc.color}`, borderRadius:20, padding:20, marginBottom:14, animation:"pt-pop-in 0.35s ease" }}>
            <div style={{ color:C.green, fontSize:11, fontWeight:800, letterSpacing:1, marginBottom:14 }}>✅ THIS WORKER ACCEPTED YOUR JOB</div>
            <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:16 }}>
              <Av initials={(booking.workerName||"W").slice(0,2).toUpperCase()} color={svc.color} size={58}/>
              <div style={{ flex:1 }}>
                <div style={{ color:C.text, fontWeight:900, fontSize:17 }}>{booking.workerName}</div>
                <Stars n={booking.workerRating} C={C}/>
              </div>
              <TrustRing trust={booking.workerTrust||70} size={52} color={svc.color}/>
            </div>
            <div style={{ background:C.card2, borderRadius:12, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ color:C.sub, fontSize:13 }}>📞 {booking.workerPhone || "—"}</span>
              <span style={{ color:C.green, fontSize:12, fontWeight:700 }}>● {booking.cancelFee>0 ? "Cancelled" : booking.status==="cancelled" ? "Cancelled" : booking.arrivedAt ? "Arrived" : ({ assigned:"Accepted", on_way:"On the way", in_progress:"Working", completed:"Job done", paid:"Job done" }[booking.status] || "Accepted")}</span>
            </div>
            {booking.workerPhone && !["cancelled"].includes(booking.status) && (
              <ContactBar phone={booking.workerPhone} name={booking.workerName} onChat={() => setShowChat(true)} C={C}/>
            )}
            {booking.workerId && (
              <button onClick={() => toggleFav(String(booking.workerId), !favIds.includes(String(booking.workerId)))} style={{ width:"100%", marginTop:10, padding:"10px 0", borderRadius:10, border:`1.5px solid ${C.red}55`, background: favIds.includes(String(booking.workerId)) ? `${C.red}22` : "transparent", color:C.red, fontWeight:800, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                {favIds.includes(String(booking.workerId)) ? "❤️ In your favourites" : "🤍 Add to favourites"}
              </button>
            )}
          </div>
        ) : (
          <div style={{ background:C.card, border:`2px solid ${svc.color}44`, borderRadius:20, padding:24, marginBottom:14, textAlign:"center" }}>
            <div style={{ position:"relative", width:60, height:60, margin:"0 auto 14px", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div style={{ position:"absolute", inset:0, borderRadius:"50%", border:`2px solid ${svc.color}`, animation:"pt-pulse-ring 1.6s ease-out infinite" }}/>
              <div style={{ position:"absolute", inset:8, borderRadius:"50%", border:`2px solid ${svc.color}`, animation:"pt-pulse-ring 1.6s ease-out infinite 0.4s" }}/>
              <div style={{ fontSize:26 }}>⏳</div>
            </div>
            <div style={{ color:C.text, fontWeight:800, fontSize:16, marginBottom:6 }}>Waiting for a worker to accept</div>
            <div style={{ color:C.muted, fontSize:13 }}>We notified all available {svc.label.toLowerCase()}s nearby. This usually takes under a minute.</div>
            <div style={{ marginTop:14, color:svc.color, fontSize:20, fontWeight:900, fontVariantNumeric:"tabular-nums" }}>{mm}:{ss}</div>
            <div style={{ marginTop:6, color:C.muted, fontSize:12 }}>Booking <span style={{ color:C.amber }}>#{booking.id}</span></div>
          </div>
        )}

        {booking.workerName && booking.status !== "cancelled" && <LiveTrack booking={booking} C={C} svc={svc}/>}

        {["pending_acceptance","assigned","on_way"].includes(booking.status) && !booking.paid && (
          <button onClick={cancelBooking} style={{ width:"100%", padding:"13px 0", background:`${C.red}14`, color:C.red, border:`1.5px solid ${C.red}44`, borderRadius:12, fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:"inherit", marginBottom:14 }}>
            ✕ Cancel booking
          </button>
        )}

        <div style={{ background:C.card2, border:`1px solid ${C.border}`, borderRadius:14, padding:16, marginBottom:16 }}>
          <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:10 }}>BOOKING SUMMARY</div>
          {booking.items.map((item,idx) => (
            <div key={idx} style={{ display:"flex", justifyContent:"space-between", color:C.sub, fontSize:13, marginBottom:6 }}>
              <span>{item.name}{qtyText(item) ? ` · ${qtyText(item)}` : ""}</span><span>₹{item.price*(item.qty||1)}</span>
            </div>
          ))}
          {booking.platformFee > 0 && (
            <>
              <div style={{ borderTop:`1px solid ${C.border}`, marginTop:10, paddingTop:10, display:"flex", justifyContent:"space-between", color:C.text, fontSize:13, fontWeight:700 }}>
                <span>Service charge</span><span>₹{booking.jobTotal}</span>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", color:C.amber, fontSize:13, fontWeight:700, marginTop:6 }}>
                <span>🏷️ ProWorkers platform charge</span><span>+₹{booking.platformFee}</span>
              </div>
            </>
          )}
          <div style={{ borderTop:`1px solid ${C.border}`, marginTop:10, paddingTop:10, display:"flex", justifyContent:"space-between", fontWeight:900, color:C.amber, fontSize:16 }}>
            <span>Total</span><span>₹{booking.total}</span>
          </div>
          {booking.paid && <div style={{ marginTop:8, color:C.green, fontSize:13, fontWeight:700 }}>✓ Paid via {booking.paymentLabel}</div>}
          {!booking.paid && booking.paymentStatus==="pending_verification" && <div style={{ marginTop:8, color:C.amber, fontSize:13, fontWeight:700 }}>⏳ Payment submitted — waiting for verification</div>}
          {!booking.paid && booking.paymentStatus==="rejected" && <div style={{ marginTop:8, color:C.red, fontSize:13, fontWeight:700 }}>❌ {booking.paymentNote || "Payment rejected. Please pay again."}</div>}
        </div>

        {booking.paid && !booking.userRating && booking.workerName && (
          <div style={{ background:C.card2, borderRadius:16, padding:18, border:`1px solid ${svc.color}44`, marginBottom:12 }}>
            <InlineRating C={C} svc={svc} workerName={booking.workerName} workerAvatar={booking.workerAvatar}
              onSubmit={async (r) => {
                try {
                  const res = await apiPost(`/bookings/${booking.id}/rating`, r);
                  const upd = normalizeBooking(res.booking);
                  setBooking(upd); onBooked(upd);
                  return true;
                } catch { return false; }
              }} />
          </div>
        )}

        {!booking.paid && (booking.status==="completed" || booking.cancelFee>0) && booking.paymentMethod!=="cash" && booking.paymentStatus!=="pending_verification" && (
          <button onClick={() => setShowPay(true)} style={{ width:"100%", padding:"16px 0", background:C.green, color:"#fff", border:"none", borderRadius:14, fontWeight:800, fontSize:16, cursor:"pointer", fontFamily:"inherit", marginBottom:10 }}>
            💳 Pay ₹{booking.total} Now
          </button>
        )}

        <button onClick={onBack} style={{ width:"100%", padding:"14px 0", background:"transparent", color:C.muted, border:`1.5px solid ${C.border}`, borderRadius:14, fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>
          ← Back to Home
        </button>

        {showChat && booking && <ChatModal booking={booking} meRole="customer" otherName={booking.workerName} otherPhone={booking.workerPhone} C={C} onClose={() => setShowChat(false)}/>}
        {showPay && (
          <PaymentModal
            total={booking.total - (booking.cashSurcharge||0)} cashCharge={cashChargeFor(booking)} jobTotal={booking.jobTotal} platformMarkup={booking.platformFee - (booking.cashSurcharge||0)} svc={svc}
            workerName={booking.workerName} workerAvatar={booking.workerAvatar}
            bookingId={booking.id} onSubmitUtr={submitUtrForBooking}
            onPay={handlePay} onClose={() => setShowPay(false)} C={C}
          />
        )}
      </div>
    );
  }

  return null;
}

// ── Complaint Modal ───────────────────────────────────────────────────────────
function ComplaintModal({ booking, onClose, onSubmit, C }) {
  const [type, setType] = useState("quality");
  const [text, setText] = useState("");
  if (!booking) return null;
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.8)", zIndex:200, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:C.card, borderRadius:"24px 24px 0 0", padding:"20px 20px 36px", width:"100%", maxWidth:480, border:`1px solid ${C.red}` }}>
        <div style={{ width:40, height:4, borderRadius:2, background:C.border, margin:"0 auto 20px" }}/>
        <h3 style={{ color:C.red, margin:"0 0 4px", fontWeight:800, fontSize:18 }}>⚠️ File a Complaint</h3>
        <p style={{ color:C.muted, fontSize:13, marginBottom:16 }}>Booking #{booking.id} · {booking.workerName}</p>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:16 }}>
          {["quality","overcharged","no-show","rude","damage"].map(t => (
            <button key={t} onClick={() => setType(t)} style={{ padding:"8px 14px", borderRadius:20, fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit", border:`1.5px solid ${type===t?C.red:C.border}`, background:type===t?`${C.red}18`:C.card2, color:type===t?C.red:C.muted }}>{t}</button>
          ))}
        </div>
        <textarea style={{ ...inp(C), minHeight:90, resize:"vertical" }} placeholder="Describe the issue…" value={text} onChange={e=>setText(e.target.value)}/>
        <div style={{ display:"flex", gap:10, marginTop:16 }}>
          <button onClick={onClose} style={{ flex:1, padding:"13px 0", background:"transparent", color:C.muted, border:`1.5px solid ${C.border}`, borderRadius:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>Cancel</button>
          <button onClick={() => { onSubmit(type, text); onClose(); }} style={{ flex:1, padding:"13px 0", background:C.red, color:"#fff", border:"none", borderRadius:12, fontWeight:800, cursor:"pointer", fontFamily:"inherit" }}>Submit</button>
        </div>
      </div>
    </div>
  );
}

// ── History Screen ────────────────────────────────────────────────────────────
function HistoryScreen({ bookings, onComplaint, onRated, onRebook, C }) {
  const [detail, setDetail] = useState(null);
  if (!bookings.length) {
    return (
      <div style={{ padding:60, textAlign:"center" }}>
        <div style={{ fontSize:48, marginBottom:14 }}>📋</div>
        <div style={{ color:C.text, fontWeight:800, fontSize:16, marginBottom:6 }}>No bookings yet</div>
        <div style={{ color:C.muted, fontSize:13 }}>Your history will appear here.</div>
      </div>
    );
  }
  return (
    <div style={{ padding:20, maxWidth:480, margin:"0 auto" }}>
      <h2 style={{ color:C.text, margin:"0 0 18px", fontWeight:900, fontSize:22 }}>My Bookings</h2>
      {bookings.map(bk => {
        const sv = SERVICES[bk.serviceType]||SERVICES.electrician;
        return (
          <div key={bk.id} onClick={() => setDetail(bk)} style={{ background:C.card, border:`1.5px solid ${sv.color}33`, borderRadius:16, padding:18, marginBottom:12, cursor:"pointer" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
              <div>
                <div style={{ color:C.text, fontWeight:700, fontSize:15 }}>{sv.icon} {sv.label}</div>
                <div style={{ color:C.muted, fontSize:12, marginTop:2 }}>#{bk.id} · {bk.date} · {bk.time}</div>
              </div>
              {(() => { const ch = bookingChip(bk, C); return (
                <span style={{ background:`${ch.color}22`, color:ch.color, fontSize:11, fontWeight:700, padding:"4px 12px", borderRadius:20 }}>{ch.text}</span>
              ); })()}
            </div>
            <div style={{ color:C.muted, fontSize:12, marginBottom:4 }}>📍 {bk.customerLocation}</div>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ color:C.sub, fontSize:13 }}>
                {bk.workerName
                  ? <>👷 <span style={{ color:C.text, fontWeight:600 }}>{bk.workerName}</span></>
                  : bk.status==="cancelled" ? <span style={{ color:C.muted, fontWeight:600 }}>No worker was assigned</span>
                  : <span style={{ color:C.amber, fontWeight:600 }}>🔍 Finding a worker…</span>}
              </div>
              {bk.status==="cancelled"
                ? <div style={{ color: bk.cancelFee>0 ? C.amber : C.muted, fontWeight:900, fontSize:14 }}>{bk.cancelFee>0 ? `Fee ₹${bk.cancelFee}` : "No charge"}</div>
                : <div style={{ color:C.amber, fontWeight:900, fontSize:15 }}>₹{bk.total}</div>}
            </div>
            {bk.userRating && <div style={{ color:C.amber, fontSize:13, marginTop:6 }}>{"★".repeat(bk.userRating.stars)} You rated</div>}
            {!bk.userRating && bk.workerName && bk.status !== "cancelled" && <div style={{ color:C.muted, fontSize:12, marginTop:6 }}>⭐ Tap to rate this worker</div>}
            <div style={{ color:C.muted, fontSize:11, marginTop:5 }}>Tap for full details →</div>
          </div>
        );
      })}
      {detail && <BookingDetailModal booking={detail} onClose={() => setDetail(null)} onComplaint={onComplaint} onRated={onRated} onRebook={onRebook} C={C}/>}
    </div>
  );
}

// ── Profile ───────────────────────────────────────────────────────────────────
// ── Profile Edit Modal ────────────────────────────────────────────────────────
function ProfileEditModal({ user, onSave, onClose, C }) {
  const [name,  setName]  = useState(user.name  || "");
  const [email, setEmail] = useState(user.email || "");
  const [phone, setPhone] = useState(user.phone || "");
  const [loc,   setLoc]   = useState(user.location || "");
  const [wtype, setWtype] = useState(user.workerType || "electrician");
  const [photo, setPhoto] = useState(user.photo || null);
  const [err,     setErr]     = useState("");
  const [saving,  setSaving]  = useState(false);
  const isWorker = user.role === "worker";
  const I = inp(C);
  const fileRef = useRef();

  // Shrink to ~300px JPEG (about 30 KB) on the phone before it is saved.
  function handlePhoto(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const MAX = 300;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        let q = 0.8, out = cv.toDataURL("image/jpeg", q);
        while (out.length > 45000 && q > 0.3) { q -= 0.1; out = cv.toDataURL("image/jpeg", q); }
        setPhoto(out);
      };
      img.onerror = () => setErr("Could not read that picture");
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!name.trim()) { setErr("Name is required"); return; }
    if (!email.trim()) { setErr("Email is required"); return; }
    setErr("");
    const updated = {
      ...user,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      location: loc.trim(),
      photo,
      avatar: (name.trim() || user.email).slice(0, 2).toUpperCase(),
    };
    if (isWorker) updated.workerType = wtype;

    // Persist to backend so changes survive logout/login
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/user/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          id:         user.id || user._id,
          role:       user.role,
          name:       updated.name,
          email:      updated.email,
          phone:      updated.phone,
          location:   updated.location,
          photo:      updated.photo,
          workerType: updated.workerType,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || "Save failed — check backend is running");
        setSaving(false);
        return;
      }
      // Merge server response back so ratings/trust fields stay intact
      onSave({ ...updated, ...data.user, token: user.token });
    } catch (e) {
      setErr("Cannot reach server. Make sure backend is running on port 5000.");
      setSaving(false);
    }
  }

  const svcColor = isWorker ? (SERVICES[wtype]?.color || C.amber) : C.amber;

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:500, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div style={{ background:C.card, borderRadius:"24px 24px 0 0", width:"100%", maxWidth:480, maxHeight:"92vh", overflowY:"auto", border:`1px solid ${C.border}` }}>
        <div style={{ width:40, height:4, borderRadius:2, background:C.border, margin:"16px auto 0" }}/>
        <div style={{ padding:"18px 20px 0", display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <span style={{ color:C.text, fontWeight:900, fontSize:20 }}>✏️ Edit Profile</span>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.muted, fontSize:22, cursor:"pointer" }}>✕</button>
        </div>

        {/* Photo picker */}
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", marginBottom:24 }}>
          <div style={{ position:"relative", cursor:"pointer" }} onClick={() => fileRef.current?.click()}>
            <Av initials={(name || "?").slice(0,2).toUpperCase()} color={svcColor} size={80} photo={photo}/>
            <div style={{ position:"absolute", bottom:0, right:0, width:26, height:26, borderRadius:"50%", background:svcColor, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, border:`2px solid ${C.card}` }}>📷</div>
          </div>
          <div style={{ color:C.muted, fontSize:12, marginTop:8 }}>Tap to change photo</div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }} onChange={handlePhoto}/>
        </div>

        <div style={{ padding:"0 20px 36px" }}>
          {[
            ["FULL NAME *", "text", "Your full name", name, setName],
            ["EMAIL *", "email", "your@email.com", email, setEmail],
            ["MOBILE NUMBER", "tel", "+91 98765 00000", phone, setPhone],
            ["AREA / LOCATION", "text", "e.g. Adajan, Surat", loc, setLoc],
          ].map(([label, type, ph, val, setter]) => (
            <div key={label} style={{ marginBottom:14 }}>
              <label style={{ color:C.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:6, letterSpacing:1 }}>{label}</label>
              <input style={I} type={type} placeholder={ph} value={val} onChange={e => setter(e.target.value)}/>
            </div>
          ))}

          {isWorker && (
            <div style={{ marginBottom:20 }}>
              <label style={{ color:C.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:8, letterSpacing:1 }}>SKILL / WORK TYPE</label>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                {Object.entries(SERVICES).map(([k, v]) => (
                  <div key={k} onClick={() => setWtype(k)} style={{ padding:"12px 6px", borderRadius:12, textAlign:"center", cursor:"pointer", border:`2px solid ${wtype===k ? v.color : C.border}`, background: wtype===k ? `${v.color}15` : C.card2 }}>
                    <div style={{ fontSize:22 }}>{v.icon}</div>
                    <div style={{ fontSize:10, fontWeight:700, color: wtype===k ? v.color : C.muted, marginTop:4 }}>{v.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {err && <div style={{ color:C.red, fontSize:13, marginBottom:14 }}>⚠️ {err}</div>}
          <button onClick={save} disabled={saving} style={{ width:"100%", padding:"15px 0", background:saving ? "#555" : svcColor, color:"#0D1117", border:"none", borderRadius:14, fontWeight:800, fontSize:16, cursor:saving?"not-allowed":"pointer", fontFamily:"inherit", opacity:saving?0.7:1 }}>
            {saving ? "⏳ Saving..." : "✅ Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Worker Completed Job Detail Modal ─────────────────────────────────────────
function WorkerJobDetailModal({ job, C, svcColor, svcIcon, onClose }) {
  if (!job) return null;
  const svcLabel = SERVICES[job.serviceType]?.label || "Service";
  const gross = job.amount || 0;
  const fee   = job.platformFee ?? 15;
  const net   = gross - fee;

  const rows = [
    ["📅 Date",      job.dateStr || "—"],
    ["⏰ Accepted",  job.acceptedAt || "—"],
    ["✅ Completed", job.completedAt || "—"],
    ["👤 Customer",  job.customerName],
    ["📞 Phone",     job.customerPhone],
    ["📍 Address",   job.address],
    ["🛠️ Service",  job.jobName],
    ["📏 Distance",  job.distance || "—"],
    ["⚡ Urgency",   job.urgency || "—"],
  ];

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.87)", zIndex:400, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background:C.card, borderRadius:"24px 24px 0 0", width:"100%", maxWidth:480, maxHeight:"92vh", overflowY:"auto", border:`1px solid ${C.border}` }}>
        <div style={{ width:40, height:4, borderRadius:2, background:C.border, margin:"16px auto 0" }}/>

        {/* Header */}
        <div style={{ padding:"18px 20px 0", display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ width:54, height:54, borderRadius:"50%", background:`${svcColor}22`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, flexShrink:0 }}>{svcIcon}</div>
          <div style={{ flex:1 }}>
            <div style={{ color:C.text, fontWeight:900, fontSize:17 }}>{job.jobName}</div>
            <div style={{ color:C.muted, fontSize:13, marginTop:2 }}>{svcLabel}</div>
          </div>
          <span style={{ background:`${C.green}22`, color:C.green, fontSize:12, fontWeight:700, padding:"6px 14px", borderRadius:20 }}>✓ Completed</span>
        </div>
        <div style={{ padding:"8px 20px 0", color:C.muted, fontSize:12 }}>Job ID: <span style={{ color:svcColor, fontWeight:700 }}>#{job.id}</span></div>

        {/* Detail rows */}
        <div style={{ margin:"16px 20px 0", background:C.card2, borderRadius:14, overflow:"hidden" }}>
          {rows.map(([k, v], i) => (
            <div key={k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"11px 16px", borderBottom: i < rows.length-1 ? `1px solid ${C.border}` : "none" }}>
              <span style={{ color:C.muted, fontSize:13 }}>{k}</span>
              <span style={{ color:C.text, fontSize:13, fontWeight:600, textAlign:"right", maxWidth:"58%" }}>{v || "—"}</span>
            </div>
          ))}
        </div>

        {/* Earnings breakdown */}
        <div style={{ margin:"16px 20px 0", background:C.card2, borderRadius:14, overflow:"hidden" }}>
          <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}`, color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1 }}>EARNINGS BREAKDOWN</div>
          {[["💰 Gross Amount", `₹${gross}`, C.text], ["🏢 Platform Fee", `−₹${fee}`, C.red]].map(([k, v, col]) => (
            <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"11px 16px", borderBottom:`1px solid ${C.border}` }}>
              <span style={{ color:C.muted, fontSize:13 }}>{k}</span>
              <span style={{ color:col, fontSize:13, fontWeight:700 }}>{v}</span>
            </div>
          ))}
          <div style={{ display:"flex", justifyContent:"space-between", padding:"14px 16px", background:`${C.green}10` }}>
            <span style={{ color:C.green, fontSize:15, fontWeight:800 }}>✅ You Earned</span>
            <span style={{ color:C.green, fontSize:17, fontWeight:900 }}>₹{net}</span>
          </div>
        </div>

        <div style={{ padding:"20px 20px 36px" }}>
          <button onClick={onClose} style={{ width:"100%", padding:"14px 0", background:C.card2, color:C.muted, border:`1.5px solid ${C.border}`, borderRadius:12, fontWeight:700, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>Close</button>
        </div>
      </div>
    </div>
  );
}

const SUPPORT_EMAIL = "proworkers.support@gmail.com";
function SupportCard({ C, topic = "" }) {
  const href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("ProWorkers support" + (topic ? " - " + topic : ""))}`;
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:16, padding:16, marginBottom:14 }}>
      <div style={{ color:C.text, fontWeight:800, fontSize:15 }}>🛟 Help & Support</div>
      <div style={{ color:C.muted, fontSize:12, marginTop:4, lineHeight:1.5 }}>Problem with a booking, payment or your account? Email us and we'll get back to you.</div>
      <a href={href} style={{ display:"block", marginTop:10, padding:"12px 0", textAlign:"center", background:C.amber, color:"#0D1117", borderRadius:12, fontWeight:800, fontSize:14, textDecoration:"none" }}>✉️ {SUPPORT_EMAIL}</a>
    </div>
  );
}

function ProfileScreen({ user, onLogout, onUpdateUser, C }) {
  const { t, lang, setLang } = useLang();
  const sv = user.workerType ? SERVICES[user.workerType] : null;
  const ac = sv?.color || C.amber;
  const [showReset, setShowReset] = useState(false);
  const [showEdit,  setShowEdit]  = useState(false);

  return (
    <div style={{ padding:20, maxWidth:480, margin:"0 auto" }}>
      <h2 style={{ color:C.text, margin:"0 0 20px", fontWeight:900, fontSize:22 }}>{t("my_profile")}</h2>
      <div style={{ background:C.card, border:`1.5px solid ${ac}44`, borderRadius:20, padding:24, marginBottom:14, textAlign:"center" }}>
        <div style={{ display:"flex", justifyContent:"center", marginBottom:14 }}>
          <Av initials={user.avatar} color={ac} size={72} photo={user.photo}/>
        </div>
        <div style={{ color:C.text, fontWeight:900, fontSize:20 }}>{user.name}</div>
        <div style={{ color:C.muted, fontSize:13, marginTop:5 }}>{user.email}</div>
        {user.phone    && <div style={{ color:C.muted, fontSize:13, marginTop:3 }}>📞 {user.phone}</div>}
        {user.location && <div style={{ color:C.muted, fontSize:13, marginTop:3 }}>📍 {user.location}</div>}
        <div style={{ marginTop:14 }}><span style={{ background:`${C.amber}22`, color:C.amber, fontSize:13, fontWeight:700, padding:"5px 16px", borderRadius:20 }}>{user.role==="worker" ? `${sv?.icon||"🔧"} ${sv?.label||t("worker")}` : `👤 ${t("customer")}`}</span></div>
      </div>
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, overflow:"hidden", marginBottom:14 }}>
        {[[t("role"), user.role==="worker"?t("worker"):t("customer")], [t("email").replace(" *",""), user.email], [t("phone").replace(" *",""), user.phone||t("not_set")], [t("area"), user.location||t("not_set")]].map(([k, v], i, arr) => (
          <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"14px 18px", borderBottom: i<arr.length-1 ? `1px solid ${C.border}` : "none" }}>
            <span style={{ color:C.muted, fontSize:14 }}>{k}</span>
            <span style={{ color:C.text, fontSize:14, fontWeight:600 }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Language — full-size selector, same style as the sign-in screen, so it's
          easy to see and tap (replaces any small/cramped top-right switcher). */}
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:16, marginBottom:14 }}>
        <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:10 }}>{t("language")}</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
          {LANGUAGES.map(l => (
            <div key={l.code} onClick={() => setLang(l.code)} style={{
              padding:"12px 6px", borderRadius:12, cursor:"pointer", textAlign:"center",
              border:"2px solid "+(lang===l.code ? ac : C.border),
              background: lang===l.code ? `${ac}18` : C.card2,
            }}>
              <div style={{ color:lang===l.code?ac:C.text, fontWeight:800, fontSize:14 }}>{l.native}</div>
            </div>
          ))}
        </div>
      </div>

      <button onClick={() => setShowEdit(true)} style={{ width:"100%", padding:"13px 0", background:`${ac}18`, color:ac, border:`1.5px solid ${ac}44`, borderRadius:14, fontWeight:700, fontSize:15, cursor:"pointer", fontFamily:"inherit", marginBottom:10 }}>{t("edit_profile")}</button>
      <button onClick={() => setShowReset(true)} style={{ width:"100%", padding:"13px 0", background:C.card2, color:C.blue||"#388BFD", border:`1.5px solid ${C.blue||"#388BFD"}33`, borderRadius:14, fontWeight:700, fontSize:15, cursor:"pointer", fontFamily:"inherit", marginBottom:10 }}>{t("change_password")}</button>
      <SupportCard C={C}/>
      <button onClick={onLogout} style={{ width:"100%", padding:"14px 0", background:`${C.red}18`, color:C.red, border:`1.5px solid ${C.red}33`, borderRadius:14, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>{t("sign_out")}</button>
      {showReset && <ResetPasswordModal AC={{ bg:"#0D1117", card:"#161B22", card2:"#1C2333", border:"#21262D", text:"#E6EDF3", muted:"#6E7681", amber:"#F0A500", red:"#F85149" }} onClose={() => setShowReset(false)}/>}
      {showEdit  && <ProfileEditModal user={user} onSave={u => { onUpdateUser(u); setShowEdit(false); }} onClose={() => setShowEdit(false)} C={C}/>}
    </div>
  );
}


// ── Home Screen ───────────────────────────────────────────────────────────────
function HomeScreen({ user, bookings, setTab, onOpenOrder, C }) {
  const isW = user.role==="worker";
  const [counts, setCounts] = useState({ electrician:0, plumber:0, labour:0 });
  useEffect(() => {
    apiGet("/workers/counts").then(setCounts).catch(() => {});
  }, []);
  const online = (counts.electrician || 0) + (counts.plumber || 0) + (counts.labour || 0);
  return (
    <div style={{ padding:20, maxWidth:480, margin:"0 auto" }}>
      <div style={{ marginBottom:22 }}>
        <div style={{ color:C.muted, fontSize:13 }}>Good day 👋</div>
        <h1 style={{ margin:"3px 0 0", color:C.text, fontWeight:900, fontSize:24 }}>{user.name}</h1>
        <div style={{ color:C.muted, fontSize:13, marginTop:3 }}>{isW?"Manage your work":""+online+" workers online in Surat"}</div>
      </div>

      {!isW && (() => {
        const act = (bookings || []).find(b => ["pending_acceptance","assigned","on_way","in_progress"].includes(b.status) || (b.status === "completed" && !b.paid) || (b.status === "cancelled" && b.cancelFee > 0 && !b.paid));
        if (!act) return null;
        const sv = SERVICES[act.serviceType] || SERVICES.electrician;
        const label = act.status === "pending_acceptance" ? (act.scheduledFor && !act.released ? "📅 Scheduled" : "Finding a worker…")
          : act.status === "assigned" ? "Worker accepted" : act.status === "on_way" ? "Worker is on the way" : act.status === "in_progress" ? "Work in progress"
          : act.status === "completed" ? "Done · pay now" : "Pay travel fee";
        return (
          <button onClick={() => onOpenOrder(act)} style={{ width:"100%", textAlign:"left", background:`${sv.color}18`, border:`2px solid ${sv.color}`, borderRadius:16, padding:"14px 16px", marginBottom:18, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:26 }}>{sv.icon}</span>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ color:sv.color, fontSize:10, fontWeight:800, letterSpacing:1 }}>YOUR ONGOING ORDER</div>
              <div style={{ color:C.text, fontWeight:800, fontSize:15, marginTop:2 }}>{label}</div>
              <div style={{ color:C.muted, fontSize:12, marginTop:1 }}>{act.workerName ? `${act.workerName} · ` : ""}₹{act.total}</div>
            </div>
            <span style={{ color:sv.color, fontWeight:800, fontSize:13 }}>Open →</span>
          </button>
        );
      })()}

      <div style={{ display:"flex", gap:10, marginBottom:20 }}>
        {(isW
          ? [["—","EARNED",C.amber],["—","JOBS",C.green],["—","RATING",C.blue]]
          : [[String(online),"ONLINE",C.green],[String(bookings.length),"BOOKINGS",C.amber],["~15m","ARRIVAL",C.blue]]
        ).map(([v,l,col]) => (
          <div key={l} style={{ flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:14, textAlign:"center" }}>
            <div style={{ color:col, fontWeight:900, fontSize:20 }}>{v}</div>
            <div style={{ color:C.muted, fontSize:10, marginTop:3, letterSpacing:0.5 }}>{l}</div>
          </div>
        ))}
      </div>

      {!isW && (
        <div onClick={() => setTab("book")} style={{ background:`linear-gradient(135deg,${C.amber}18,${C.card})`, border:`1.5px solid ${C.amber}44`, borderRadius:20, padding:20, marginBottom:20, cursor:"pointer" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div><div style={{ color:C.amber, fontWeight:900, fontSize:18 }}>Book a Worker</div><div style={{ color:C.muted, fontSize:13, marginTop:4 }}>Electrician · Plumber · Labour</div></div>
            <div style={{ fontSize:36 }}>🛠️</div>
          </div>
          <div style={{ marginTop:16, background:C.amber, color:"#0D1117", borderRadius:10, padding:"12px 0", textAlign:"center", fontWeight:800, fontSize:15 }}>Book Now →</div>
        </div>
      )}

      <div style={{ marginBottom:20 }}>
        <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:12 }}>SERVICES</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
          {Object.entries(SERVICES).map(([k,v]) => {
            const cnt = counts[k] || 0;
            const busyAll = cnt > 0 && (counts.free?.[k] ?? cnt) === 0;
            return (
              <div key={k} onClick={() => { if(!isW) setTab("book"); }} style={{ background:C.card, border:`1.5px solid ${v.color}33`, borderRadius:14, padding:"16px 8px", textAlign:"center", cursor:isW?"default":"pointer" }}>
                <div style={{ fontSize:26, marginBottom:5 }}>{v.icon}</div>
                <div style={{ color:C.text, fontWeight:700, fontSize:11, marginBottom:4 }}>{v.label}</div>
                <div style={{ color: busyAll ? C.amber : C.green, fontSize:10, fontWeight:700 }}>● {busyAll ? "busy now" : `${cnt} online`}</div>
              </div>
            );
          })}
        </div>
      </div>

      {!isW && bookings.length>0 && (
        <div>
          <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:12 }}>RECENT BOOKING</div>
          {bookings.slice(0,1).map(bk => {
            const sv = SERVICES[bk.serviceType]||SERVICES.electrician;
            return (
              <div key={bk.id} onClick={() => setTab("history")} style={{ background:C.card, border:`1.5px solid ${sv.color}33`, borderRadius:16, padding:16, cursor:"pointer" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div><div style={{ color:C.text, fontWeight:700 }}>{sv.icon} {sv.label}</div><div style={{ color:C.muted, fontSize:12, marginTop:2 }}>#{bk.id} · {bk.workerName}</div></div>
                  <div style={{ color:C.amber, fontWeight:900, fontSize:16 }}>₹{bk.total}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ── Worker App ───────────────────────────────────────────────────────────────
// Simulated incoming requests (in production these come from backend)
// NOTE: Worker job requests are now real bookings fetched from the backend
// (/api/bookings/worker/:id) — there is no demo/fake request data.

// ── Notification Permission Banner ────────────────────────────────────────────
function NotificationBanner({ C, onDismiss }) {
  const [asked, setAsked] = useState(false);
  async function allow() {
    let granted = false;
    try {
      if (Capacitor.isNativePlatform()) {
        // Android app: ask Android for the notification permission (Android 13+ shows a system prompt)
        const r = await LocalNotifications.requestPermissions();
        granted = r.display === "granted";
      } else if ("Notification" in window) {
        granted = (await Notification.requestPermission()) === "granted";
      }
    } catch {}
    localStorage.setItem("pt_notif_perm", granted ? "granted" : "denied");
    setAsked(true);
    onDismiss(granted);
  }
  function deny() { localStorage.setItem("pt_notif_perm", "denied"); onDismiss(false); }
  if (asked) return null;
  return (
    <div style={{ position:"fixed", bottom:80, left:12, right:12, background:C.card, border:`1.5px solid ${C.amber}`, borderRadius:18, padding:"16px 18px", zIndex:200, boxShadow:"0 8px 32px #0009" }}>
      <div style={{ display:"flex", alignItems:"flex-start", gap:12 }}>
        <span style={{ fontSize:28, flexShrink:0 }}>🔔</span>
        <div style={{ flex:1 }}>
          <div style={{ color:C.text, fontWeight:800, fontSize:15, marginBottom:4 }}>Enable Notifications</div>
          <div style={{ color:C.muted, fontSize:12, lineHeight:1.5 }}>Get alerts for bookings, worker arrival, payment updates and more.</div>
          <div style={{ display:"flex", gap:10, marginTop:12 }}>
            <button onClick={allow} style={{ flex:1, padding:"10px 0", background:C.amber, color:"#0D1117", border:"none", borderRadius:10, fontWeight:800, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>✓ Allow</button>
            <button onClick={deny}  style={{ flex:1, padding:"10px 0", background:C.card2, color:C.muted, border:`1px solid ${C.border}`, borderRadius:10, fontWeight:700, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>✗ Deny</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Utility: push a local notification ───────────────────────────────────────
let _notifId = Math.floor(Date.now() / 1000) % 1000000000;

// ── Real push notifications (Firebase Cloud Messaging) ───────────────────────
// The server sends a push for new job requests, worker assigned, payment and withdrawal
// decisions and admin alerts. Android shows them even when the app is CLOSED.
//  • App hidden / closed  → Android draws the push itself (nothing to do here).
//  • App open             → we draw it as a local notification (Android does not draw
//                           pushes while the app is in front).
// _pushReady = this phone is registered for push, so the older "poll and notify" path
// stays quiet while the app is hidden (otherwise you would see every alert twice).
let _pushReady = false;
let _pushListeners = false;
const _recentNotif = new Map();            // title -> time, stops duplicate popups
function _seenRecently(title) {
  const now = Date.now();
  const last = _recentNotif.get(title);
  _recentNotif.set(title, now);
  return last !== undefined && now - last < 45000;
}
function _showLocal(title, body) {
  LocalNotifications.schedule({
    notifications: [{ id: ++_notifId, title, body, smallIcon: "ic_stat_proworkers", iconColor: "#F0A500" }],
  }).catch(() => {});
}
async function setupPush() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (!_pushListeners) {
      _pushListeners = true;
      await PushNotifications.addListener("registration", async (tk) => {
        try {
          const jwt = localStorage.getItem("pt_token");
          if (!jwt || !tk?.value) return;
          localStorage.setItem("pt_fcm_token", tk.value);
          const res = await fetch(API_BASE + "/push/register", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
            body: JSON.stringify({ token: tk.value }),
          });
          _pushReady = res.ok;
        } catch { _pushReady = false; }
      });
      await PushNotifications.addListener("registrationError", () => { _pushReady = false; });
      // Tapping a notification: tell the open screen which tab to show
      await PushNotifications.addListener("pushNotificationActionPerformed", (a) => {
        const d = a?.notification?.data || {};
        window.__pwPendingOpen = d;
        window.dispatchEvent(new CustomEvent("pw-push-open", { detail: d }));
      });
      await PushNotifications.addListener("pushNotificationReceived", (n) => {
        // Only fires while the app is open
        if (n?.title && !_seenRecently(n.title)) _showLocal(n.title, n.body || "");
      });
    }
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return;
    localStorage.setItem("pt_notif_perm", "granted");
    await PushNotifications.createChannel({
      id: "alerts", name: "ProWorkers alerts", description: "Job requests, bookings, payments and payouts",
      importance: 5, visibility: 1, vibration: true, lights: true,
    }).catch(() => {});
    PushNotifications.register().catch(() => {});   // never awaited: must not block the app
  } catch {}
}
async function teardownPush() {
  _pushReady = false;
  try { if (Capacitor.isNativePlatform()) await UpiWatcher.clearConfig(); } catch {}
  try {
    const jwt = localStorage.getItem("pt_token");
    const tk  = localStorage.getItem("pt_fcm_token");
    if (jwt && tk) {
      await fetch(API_BASE + "/push/unregister", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
        body: JSON.stringify({ token: tk }),
      });
    }
  } catch {}
}

// A screen calls this to react when the user taps a notification (also if the tap opened the app)
function usePushOpen(handler) {
  const ref = useRef(handler); ref.current = handler;
  useEffect(() => {
    const run = d => { window.__pwPendingOpen = null; try { ref.current(d || {}); } catch {} };
    if (window.__pwPendingOpen) run(window.__pwPendingOpen);
    const on = e => run(e.detail);
    window.addEventListener("pw-push-open", on);
    return () => window.removeEventListener("pw-push-open", on);
  }, []);
}

function pushNotif(title, body, icon="🛠️") {
  if (localStorage.getItem("pt_notif_perm") !== "granted") return;
  // Android app: the browser Notification API does not exist in the WebView, so use the native one
  if (Capacitor.isNativePlatform()) {
    // App hidden and push is active: Firebase already shows it, so skip to avoid a double alert
    if (_pushReady && typeof document !== "undefined" && document.hidden) return;
    if (_seenRecently(title)) return;
    _showLocal(title, body);
    return;
  }
  if (!("Notification" in window)) return;
  try { new Notification(title, { body, icon:"/favicon.ico" }); } catch {}
}

// ── Worker Profile Tab (extracted so it can use its own state for showReset) ──
function WorkerProfileTab({ user, svcColor, svcIcon, C, onEditProfile, onLogout }) {
  const { t, lang, setLang } = useLang();
  const [showReset, setShowReset] = useState(false);
  return (
    <div style={{ padding:20, maxWidth:480, margin:"0 auto" }}>
      <h2 style={{ color:C.text, margin:"0 0 20px", fontWeight:900, fontSize:22 }}>{t("my_profile")}</h2>
      <div style={{ background:C.card, border:`1.5px solid ${svcColor}44`, borderRadius:20, padding:24, marginBottom:16, textAlign:"center" }}>
        <div style={{ display:"flex", justifyContent:"center", marginBottom:14 }}>
          <Av initials={user.avatar} color={svcColor} size={72} photo={user.photo}/>
        </div>
        <div style={{ color:C.text, fontWeight:900, fontSize:20 }}>{user.name}</div>
        <div style={{ color:C.muted, fontSize:13, marginTop:4 }}>{user.email}</div>
        <div style={{ marginTop:10, display:"flex", justifyContent:"center", gap:8, flexWrap:"wrap" }}>
          <span style={{ background:`${svcColor}22`, color:svcColor, fontSize:12, fontWeight:700, padding:"4px 14px", borderRadius:20 }}>{svcIcon} {SERVICES[user.workerType]?.label||t("worker")}</span>
          <span style={{ background:"#3FB95022", color:"#3FB950", fontSize:12, fontWeight:700, padding:"4px 14px", borderRadius:20 }}>✓ Registered</span>
        </div>
      </div>
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, overflow:"hidden", marginBottom:16 }}>
        {[[t("phone").replace(" *",""), user.phone||t("not_set")], [t("area"), user.location||t("not_set")], [t("your_skill").replace(" *",""), SERVICES[user.workerType]?.label||"—"], [t("email").replace(" *",""), user.email]].map(([k,v],i,arr) => (
          <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"14px 18px", borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none" }}>
            <span style={{ color:C.muted, fontSize:14 }}>{k}</span>
            <span style={{ color:C.text, fontSize:14, fontWeight:600, maxWidth:"60%", textAlign:"right", wordBreak:"break-all" }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Language — full-size selector, same style as the sign-in screen, so it's
          easy to see and tap (replaces any small/cramped top-right switcher). */}
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:16, marginBottom:16 }}>
        <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:10 }}>{t("language")}</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
          {LANGUAGES.map(l => (
            <div key={l.code} onClick={() => setLang(l.code)} style={{
              padding:"12px 6px", borderRadius:12, cursor:"pointer", textAlign:"center",
              border:"2px solid "+(lang===l.code ? svcColor : C.border),
              background: lang===l.code ? `${svcColor}18` : C.card2,
            }}>
              <div style={{ color:lang===l.code?svcColor:C.text, fontWeight:800, fontSize:14 }}>{l.native}</div>
            </div>
          ))}
        </div>
      </div>

      <button onClick={onEditProfile} style={{ width:"100%", padding:"13px 0", background:`${svcColor}18`, color:svcColor, border:`1.5px solid ${svcColor}44`, borderRadius:14, fontWeight:700, fontSize:15, cursor:"pointer", fontFamily:"inherit", marginBottom:10 }}>{t("edit_profile")}</button>
      <button onClick={() => setShowReset(true)} style={{ width:"100%", padding:"13px 0", background:C.card2, color:C.blue||"#388BFD", border:`1.5px solid ${C.blue||"#388BFD"}33`, borderRadius:14, fontWeight:700, fontSize:15, cursor:"pointer", fontFamily:"inherit", marginBottom:10 }}>{t("change_password")}</button>
      <SupportCard C={C}/>
      <button onClick={onLogout} style={{ width:"100%", padding:"14px 0", background:`${C.red}18`, color:C.red, border:`1.5px solid ${C.red}33`, borderRadius:14, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>{t("sign_out")}</button>
      {showReset && <ResetPasswordModal AC={{ bg:"#0D1117", card:"#161B22", card2:"#1C2333", border:"#21262D", text:"#E6EDF3", muted:"#6E7681", amber:"#F0A500", red:"#F85149" }} onClose={() => setShowReset(false)}/>}
    </div>
  );
}

// ── Worker withdraw + calendar screens ───────────────────────────────────────
// These live at module level on purpose. They used to be declared inside WorkerApp,
// so every re-render (the app polls the server every 8s) created a brand-new component
// type: React unmounted the old one and everything typed in the form was wiped.
// Values from WorkerApp come in through `ctx`.
// ── Withdrawal Modal with success screen + history ─────────────────────────
// Worker pays ProWorkers the fee they owe from cash jobs (UPI), then says "I paid"; the admin confirms.
function DuesPayBox({ C, outstanding, pending, onSubmitted }) {
  const [open, setOpen] = useState(false);
  const [upi,  setUpi]  = useState("");
  const [amt,  setAmt]  = useState(String(outstanding));
  const [utr,  setUtr]  = useState("");
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (open) apiGet("/settings").then(d => setUpi(d.upiId || "")).catch(() => {}); }, [open]);
  useEffect(() => { setAmt(a => (Number(a) > outstanding || !a) ? String(outstanding) : a); }, [outstanding]);
  if (pending > 0) {
    return <div style={{ marginTop:10, background:`${C.amber}18`, border:`1px solid ${C.amber}55`, borderRadius:10, padding:"10px 12px", color:C.amber, fontWeight:700, fontSize:13 }}>⏳ You said you paid ₹{pending}. We are checking it.</div>;
  }
  const n = Math.round(Number(amt) || 0);
  const valid = n >= 1 && n <= outstanding;
  async function submit() {
    setErr(""); setBusy(true);
    try { await apiPost("/worker/dues-payment", { amount: n, utr: utr.trim() }); setOpen(false); setUtr(""); onSubmitted && onSubmitted(); }
    catch (e) { setErr(e.message || "Could not send. Try again."); }
    setBusy(false);
  }
  if (!open) {
    return <button onClick={() => setOpen(true)} style={{ marginTop:10, width:"100%", padding:"12px 0", background:C.red, color:"#fff", border:"none", borderRadius:10, fontWeight:800, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>💳 Pay ₹{outstanding} now</button>;
  }
  return (
    <div style={{ marginTop:10, background:C.card2, border:`1px solid ${C.border}`, borderRadius:12, padding:14 }}>
      <div style={{ color:C.muted, fontSize:12, marginBottom:6 }}>Amount to pay (₹)</div>
      <input value={amt} onChange={e => setAmt(e.target.value.replace(/\D/g, ""))} inputMode="numeric" style={{ width:"100%", boxSizing:"border-box", background:C.card, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"10px 12px", fontSize:16, fontFamily:"inherit" }}/>
      {upi ? (
        <>
          <a href={`upi://pay?${buildUpiParams(upi, n || outstanding, "dues")}`} style={{ display:"block", marginTop:10, textAlign:"center", background:C.green, color:"#fff", borderRadius:10, padding:"12px 0", fontWeight:800, fontSize:14, textDecoration:"none" }}>Pay ₹{n || outstanding} with a UPI app</a>
          <div style={{ marginTop:8, fontSize:12, color:C.muted, display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
            <span>UPI ID: <b style={{ color:C.text }}>{upi}</b></span>
            <button onClick={() => { try { navigator.clipboard.writeText(upi); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} }} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.sub, borderRadius:8, padding:"4px 10px", fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>{copied ? "Copied" : "Copy"}</button>
          </div>
        </>
      ) : <div style={{ marginTop:10, fontSize:12, color:C.muted }}>Loading the UPI ID…</div>}
      <div style={{ color:C.muted, fontSize:12, margin:"12px 0 6px" }}>After you pay, enter the 12-digit UTR (optional)</div>
      <input value={utr} onChange={e => setUtr(e.target.value.replace(/\D/g, "").slice(0, 12))} inputMode="numeric" placeholder="UTR number" style={{ width:"100%", boxSizing:"border-box", background:C.card, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"10px 12px", fontSize:14, fontFamily:"inherit" }}/>
      {err && <div style={{ color:C.red, fontSize:12, marginTop:8 }}>{err}</div>}
      <button onClick={submit} disabled={!valid || busy} style={{ marginTop:10, width:"100%", padding:"12px 0", background:C.amber, color:"#0D1117", border:"none", borderRadius:10, fontWeight:800, fontSize:14, cursor: valid && !busy ? "pointer" : "default", opacity: valid && !busy ? 1 : 0.5, fontFamily:"inherit" }}>{busy ? "Sending…" : "✅ I have paid"}</button>
      <button onClick={() => setOpen(false)} style={{ marginTop:6, width:"100%", background:"transparent", border:"none", color:C.muted, fontSize:12, cursor:"pointer", fontFamily:"inherit", padding:6 }}>Cancel</button>
    </div>
  );
}

function WithdrawModal({ ctx }) {
  const { C, PLATFORM_DEDUCT, CASH_PLATFORM_CUT, availableBalance, cashJobsConfirmedCount, mapWd, platformOwedFromCash, prevWdStatus,
          setShowWithdraw, setUpiId, setWithdrawHistory, totalWithdrawn, upiId, user, withdrawHistory, duesOutstanding, duesPending, reloadWithdrawals, CASH_DUES_LIMIT } = ctx;
  const [amt, setAmt] = useState("");
  const [upi, setUpi] = useState(upiId);
  const [done, setDone] = useState(false);
  const [showWHistory, setShowWHistory] = useState(false);
  const [withdrawnAmt, setWithdrawnAmt] = useState(0);
  const [withdrawnUpi, setWithdrawnUpi] = useState("");
  const [withdrawId,   setWithdrawId]   = useState("");
  const [err, setErr] = useState("");
  const I2 = { width:"100%", padding:"13px 16px", background:C.card2, border:`1.5px solid ${C.border}`, borderRadius:12, color:C.text, fontSize:15, outline:"none", boxSizing:"border-box", fontFamily:"inherit" };

  async function submit() {
    if (!upi.trim()) { setErr("Enter your UPI ID"); return; }
    if (!amt || isNaN(amt) || Number(amt) < 1) { setErr("Enter a valid amount"); return; }
    if (Number(amt) > availableBalance) { setErr(`Max available: ₹${availableBalance}`); return; }
    setErr("");
    try {
      const res = await apiPost("/withdrawals", { workerId: user.id, amount: Number(amt), upi: upi.trim() });
      setUpiId(upi); localStorage.setItem("pt_upi_"+user.id, upi);
      const rec = mapWd(res.withdrawal);
      prevWdStatus.current = { ...(prevWdStatus.current || {}), [rec._id]: "requested" };
      setWithdrawHistory(prev => [rec, ...prev]);
      setWithdrawnAmt(Number(amt)); setWithdrawnUpi(upi.trim()); setWithdrawId(rec.id);
      setDone(true);
      pushNotif("Withdrawal Requested", `₹${amt} to ${upi} — waiting for admin to pay.`);
    } catch (e) {
      setErr(e.message || "Could not send request. Try again.");
    }
  }

  if (showWHistory) {
    return (
      <div style={{ position:"fixed", inset:0, background:"#000c", zIndex:800, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
        <div style={{ background:C.card, borderRadius:"24px 24px 0 0", padding:"20px 20px 36px", width:"100%", maxWidth:480, maxHeight:"85vh", overflowY:"auto", border:`1px solid ${C.border}` }}>
          <div style={{ width:40, height:4, borderRadius:2, background:C.border, margin:"0 auto 16px" }}/>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
            <span style={{ color:C.text, fontWeight:900, fontSize:18 }}>📋 Withdrawal History</span>
            <button onClick={()=>setShowWHistory(false)} style={{ background:"none", border:"none", color:C.muted, fontSize:22, cursor:"pointer" }}>✕</button>
          </div>
          {withdrawHistory.length===0 ? (
            <div style={{ textAlign:"center", padding:"40px 0", color:C.muted }}>No withdrawals yet.</div>
          ) : withdrawHistory.map((w,i) => (
            <div key={i} style={{ background:C.card2, borderRadius:14, padding:16, marginBottom:10, border:`1px solid ${C.border}` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                <div>
                  <div style={{ color:C.text, fontWeight:800, fontSize:15 }}>₹{w.amount}</div>
                  <div style={{ color:C.muted, fontSize:12, marginTop:2 }}>📱 {w.upi}</div>
                </div>
                <span style={{ background:`${w.status==="paid"?C.green:w.status==="rejected"?C.red:C.amber}22`, color:w.status==="paid"?C.green:w.status==="rejected"?C.red:C.amber, fontSize:11, fontWeight:700, padding:"4px 12px", borderRadius:20 }}>{w.status==="requested"?"Pending":w.status==="paid"?"Paid":"Rejected"}</span>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", color:C.muted, fontSize:12 }}>
                <span>📅 {w.date}</span><span>⏰ {w.time}</span>
              </div>
              <div style={{ color:C.muted, fontSize:11, marginTop:4 }}>Ref: #{w.id}{w.payoutUtr ? ` · UTR ${w.payoutUtr}` : ""}</div>
              {w.status==="rejected" && w.adminNote && <div style={{ color:C.red, fontSize:11, marginTop:4 }}>{w.adminNote}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"#000c", zIndex:800, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:C.card, borderRadius:20, padding:28, width:"100%", maxWidth:390, border:`1px solid ${C.border}`, maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <span style={{ color:C.text, fontWeight:900, fontSize:18 }}>💰 Withdraw Earnings</span>
          <button onClick={()=>setShowWithdraw(false)} style={{ background:"none", border:"none", color:C.muted, fontSize:22, cursor:"pointer" }}>✕</button>
        </div>
        {done ? (
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:56, marginBottom:8 }}>✅</div>
            <div style={{ color:C.green, fontWeight:900, fontSize:20, marginBottom:4 }}>Withdrawal Requested!</div>
            <div style={{ color:C.muted, fontSize:13, marginBottom:24 }}>Your request has been submitted</div>
            {/* Receipt */}
            <div style={{ background:C.card2, borderRadius:16, padding:20, marginBottom:20, border:`1px solid ${C.green}44`, textAlign:"left" }}>
              <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:14 }}>WITHDRAWAL RECEIPT</div>
              {[["💰 Amount",`₹${withdrawnAmt}`],["📱 UPI ID",withdrawnUpi],["🆔 Reference","#"+withdrawId],["📅 Date",new Date().toLocaleDateString("en-IN")],["⏰ Time",new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})],["📊 Status","Waiting for admin"]].map(([k,v],i,arr)=>(
                <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"9px 0", borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none" }}>
                  <span style={{ color:C.muted, fontSize:13 }}>{k}</span>
                  <span style={{ color:i===0?C.green:C.text, fontWeight:700, fontSize:13 }}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={()=>setShowWHistory(true)} style={{ flex:1, padding:"12px 0", background:C.card2, color:C.text, border:`1px solid ${C.border}`, borderRadius:12, fontWeight:700, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>📋 History</button>
              <button onClick={()=>setShowWithdraw(false)} style={{ flex:1, padding:"12px 0", background:C.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>Done ✓</button>
            </div>
          </div>
        ) : (
          <>
            {duesOutstanding > 0 && (
              <div style={{ background:`${C.red}18`, border:`1px solid ${C.red}55`, borderRadius:12, padding:14, marginBottom:14, fontSize:13, color:C.text, lineHeight:1.5 }}>
                <b style={{ color:C.red }}>You have to pay ProWorkers ₹{duesOutstanding}</b>. This is our fee from your cash jobs.
                {duesOutstanding > CASH_DUES_LIMIT ? ` You can't get new jobs until you pay it.` : ` You can't get new jobs if it goes above ₹${CASH_DUES_LIMIT}.`}
                {" "}We cut it from your online earnings. Or you can pay it now below.
                <DuesPayBox C={C} outstanding={duesOutstanding} pending={duesPending} onSubmitted={reloadWithdrawals}/>
              </div>
            )}
            <div style={{ background:`${C.green}18`, border:`1px solid ${C.green}44`, borderRadius:12, padding:16, marginBottom:20, textAlign:"center" }}>
              <div style={{ color:C.muted, fontSize:12, marginBottom:4 }}>Available Balance</div>
              <div style={{ color:C.green, fontWeight:900, fontSize:30 }}>₹{availableBalance}</div>
              <div style={{ color:C.muted, fontSize:11, marginTop:4 }}>Platform fee deducted: ₹10 per online job, ₹15 per cash job{totalWithdrawn>0?` · ₹${totalWithdrawn} already withdrawn`:""}</div>
              {cashJobsConfirmedCount>0 && <div style={{ color:C.muted, fontSize:11, marginTop:4 }}>{cashJobsConfirmedCount} cash job{cashJobsConfirmedCount>1?"s":""}: ₹{platformOwedFromCash} our fee, kept from your balance — you already got this money in cash</div>}
            </div>
            <div style={{ marginBottom:14 }}>
              <label style={{ color:C.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:6, letterSpacing:1 }}>YOUR UPI ID</label>
              <input style={I2} placeholder="yourname@upi / phone@paytm" value={upi} onChange={e=>setUpi(e.target.value)}/>
            </div>
            <div style={{ marginBottom:16 }}>
              <label style={{ color:C.muted, fontSize:11, fontWeight:700, display:"block", marginBottom:6, letterSpacing:1 }}>AMOUNT (₹)</label>
              <input style={I2} type="number" placeholder={`Max ₹${availableBalance}`} value={amt} onChange={e=>setAmt(e.target.value)}/>
            </div>
            {err && <div style={{ color:C.red, fontSize:13, marginBottom:12 }}>⚠️ {err}</div>}
            <button onClick={submit} style={{ width:"100%", padding:"14px 0", background:C.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit", marginBottom:12 }}>
              Request Withdrawal →
            </button>
            {withdrawHistory.length > 0 && (
              <button onClick={()=>setShowWHistory(true)} style={{ width:"100%", padding:"12px 0", background:C.card2, color:C.text, border:`1px solid ${C.border}`, borderRadius:12, fontWeight:700, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                📋 View History ({withdrawHistory.length})
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}


// Fix 4: Calendar view
function CalendarView({ ctx }) {
  const { C, accepted, calMonth, setCalMonth, setSelJobDetail, setShowCalendar, svcColor } = ctx;
  const year  = calMonth.getFullYear();
  const month = calMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const monthName = calMonth.toLocaleDateString("en-IN",{month:"long",year:"numeric"});

  // Group completed jobs by date
  const jobsByDate = {};
  accepted.filter(r=>r.status==="completed" && r.dateISO).forEach(r => {
    const d = r.dateISO;
    if (!jobsByDate[d]) jobsByDate[d] = [];
    jobsByDate[d].push(r);
  });

  const today = localDateKey(new Date());
  const [selDate, setSelDate] = useState(null);
  const selJobs = selDate ? (jobsByDate[selDate]||[]) : [];
  const selKey = `${year}-${String(month+1).padStart(2,"0")}`;

  return (
    <div style={{ position:"fixed", inset:0, background:C.bg, zIndex:300, overflowY:"auto", paddingBottom:80 }}>
      <div style={{ background:C.card, borderBottom:`1px solid ${C.border}`, padding:"14px 20px", display:"flex", alignItems:"center", gap:12 }}>
        <button onClick={()=>setShowCalendar(false)} style={{ background:"none", border:"none", color:C.muted, fontSize:22, cursor:"pointer" }}>←</button>
        <span style={{ color:C.text, fontWeight:900, fontSize:18 }}>📅 Work Calendar</span>
      </div>

      <div style={{ padding:"20px 20px 0", maxWidth:480, margin:"0 auto" }}>
        {/* Month navigation */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <button onClick={()=>setCalMonth(new Date(year, month-1,1))} style={{ background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:10, padding:"8px 14px", cursor:"pointer", fontFamily:"inherit", fontWeight:700 }}>‹</button>
          <span style={{ color:C.text, fontWeight:800, fontSize:16 }}>{monthName}</span>
          <button onClick={()=>setCalMonth(new Date(year, month+1,1))} style={{ background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:10, padding:"8px 14px", cursor:"pointer", fontFamily:"inherit", fontWeight:700 }}>›</button>
        </div>

        {/* Day labels */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4, marginBottom:6 }}>
          {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => (
            <div key={d} style={{ textAlign:"center", color:C.muted, fontSize:11, fontWeight:700, padding:"4px 0" }}>{d}</div>
          ))}
        </div>

        {/* Calendar grid */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4, marginBottom:20 }}>
          {Array.from({length: firstDay}).map((_,i) => <div key={"e"+i}/>)}
          {Array.from({length: daysInMonth}).map((_,i) => {
            const day = i+1;
            const dateKey = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
            const dayJobs = jobsByDate[dateKey]||[];
            const isToday = dateKey === today;
            const isSel   = dateKey === selDate;
            const earned  = dayJobs.reduce((s,r)=>s+r.amount,0);
            return (
              <div key={day} onClick={()=>setSelDate(isSel ? null : dateKey)} style={{
                textAlign:"center", padding:"6px 2px", borderRadius:10, cursor:"pointer",
                background: isSel ? svcColor : isToday ? `${svcColor}22` : dayJobs.length>0 ? `${C.green}18` : "transparent",
                border: isSel ? `2px solid ${svcColor}` : isToday ? `1.5px solid ${svcColor}44` : `1px solid ${C.border}`,
              }}>
                <div style={{ color: isSel?"#0D1117" : isToday?svcColor : C.text, fontWeight:isSel||isToday?800:500, fontSize:13 }}>{day}</div>
                {dayJobs.length>0 && <div style={{ color:isSel?"#0D1117":C.green, fontSize:9, fontWeight:700, marginTop:1 }}>₹{earned}</div>}
                {dayJobs.length>0 && <div style={{ width:5,height:5,borderRadius:"50%",background:isSel?"#0D1117":C.green, margin:"2px auto 0" }}/>}
              </div>
            );
          })}
        </div>

        {/* Monthly summary */}
        {(() => {
          const monthJobs = accepted.filter(r=>r.status==="completed" && r.dateISO?.startsWith(selKey));
          const monthEarned = monthJobs.reduce((s,r)=>s+r.amount,0);
          return (
            <div style={{ display:"flex", gap:10, marginBottom:20 }}>
              <div style={{ flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:14, textAlign:"center" }}>
                <div style={{ color:C.amber, fontWeight:900, fontSize:20 }}>₹{monthEarned}</div>
                <div style={{ color:C.muted, fontSize:10, marginTop:3 }}>THIS MONTH</div>
              </div>
              <div style={{ flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:14, textAlign:"center" }}>
                <div style={{ color:C.green, fontWeight:900, fontSize:20 }}>{monthJobs.length}</div>
                <div style={{ color:C.muted, fontSize:10, marginTop:3 }}>JOBS THIS MONTH</div>
              </div>
            </div>
          );
        })()}

        {/* Selected day detail */}
        {selDate && (
          <div style={{ marginBottom:16 }}>
            <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:10 }}>
              {new Date(selDate+"T00:00:00").toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long"})}
            </div>
            {selJobs.length===0 ? (
              <div style={{ color:C.muted, fontSize:13, textAlign:"center", padding:20 }}>No jobs on this day</div>
            ) : selJobs.map((j,i) => (
              <div key={i} onClick={() => { setSelJobDetail(j); setShowCalendar(false); }} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:14, marginBottom:8, display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer" }}>
                <div>
                  <div style={{ color:C.text, fontWeight:700, fontSize:14 }}>{j.jobName}</div>
                  <div style={{ color:C.muted, fontSize:12, marginTop:2 }}>{j.customerName} · {j.acceptedAt}</div>
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ color:C.green, fontWeight:900, fontSize:16 }}>₹{j.amount}</div>
                  <div style={{ color:C.muted, fontSize:10, marginTop:2 }}>Tap for details →</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


function WorkerApp({ user: initialUser, onLogout, onUpdateUser, C, toast, setToast }) {
  const { t } = useLang();
  const [user, setUser] = useState(initialUser);
  const [tab,        setTab]      = useState("requests");
  usePushOpen(d => setTab(d.type === "new_request" ? "requests" : d.type === "withdrawal" ? "earnings" : "active"));
  // Real bookings assigned to this worker — no more fake DEMO_REQUESTS.
  const [allJobs,    setAllJobs]  = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [isOnline,   setIsOnline] = useState(initialUser.isOnline !== false);
  const lastToggleAt = useRef(0);
  // Live location: shared only while online with the app open, only the latest point is stored on the
  // server, and it is deleted when the worker goes offline or logs out. Needs the worker's clear OK.
  const [locConsent, setLocConsent] = useState(() => { try { return localStorage.getItem("pt_loc_consent") || ""; } catch { return ""; } });  // "yes" | "no" | ""
  const [locOk,      setLocOk]      = useState(false);   // last location send worked
  function answerLoc(v) { try { localStorage.setItem("pt_loc_consent", v); } catch {} setLocConsent(v); }
  const trackingNow = allJobs.some(r => ["assigned","on_way"].includes(r.status) && String(r.workerId) === String(initialUser.id));
  useEffect(() => {
    if (!isOnline || locConsent !== "yes") { setLocOk(false); return; }
    let stopped = false;
    const send = () => {
      if (stopped || document.hidden || !navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        pos => { if (!stopped) apiPost("/worker/location", { lat: pos.coords.latitude, lng: pos.coords.longitude }).then(() => setLocOk(true)).catch(() => {}); },
        () => setLocOk(false),
        { enableHighAccuracy:false, timeout:15000, maximumAge:30000 }
      );
    };
    send();
    const timer = setInterval(send, trackingNow ? 15000 : 60000);
    const vis = () => { if (!document.hidden) send(); };
    document.addEventListener("visibilitychange", vis);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", vis); };
  }, [isOnline, locConsent, trackingNow]);
  // With the screen off the browser stops giving locations. While the worker has an accepted job, run a
  // small foreground service (shows a "ProWorkers is sharing your location" notification) so the customer can still follow them.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !isOnline || locConsent !== "yes" || !trackingNow) return;
    let id = null, dead = false, last = 0;
    BackgroundGeolocation.addWatcher(
      { backgroundMessage: "Sharing your location with your customer for the active job.", backgroundTitle: "ProWorkers · job in progress", requestPermissions: true, stale: false, distanceFilter: 25 },
      (loc, err) => {
        if (err || !loc || dead || Date.now() - last < 10000) return;
        last = Date.now();
        apiPost("/worker/location", { lat: loc.latitude, lng: loc.longitude }).then(() => setLocOk(true)).catch(() => {});
      }
    ).then(wid => { if (dead) BackgroundGeolocation.removeWatcher({ id: wid }); else id = wid; }).catch(() => {});
    return () => { dead = true; if (id) BackgroundGeolocation.removeWatcher({ id }).catch?.(() => {}); };
  }, [isOnline, locConsent, trackingNow]);
  const [selReq,     setSelReq]   = useState(null);
  const [showNotifBanner, setShowNotifBanner] = useState(() => {
    return !localStorage.getItem("pt_notif_perm");
  });
  const [showEdit, setShowEdit] = useState(false);
  const [selJobDetail, setSelJobDetail] = useState(null);
  const [chatJob, setChatJob] = useState(null);

  const seenReqIds = useRef(null);   // ids of incoming requests the worker has already been told about
  async function loadJobs() {
    try {
      // The server decides who customers can see. If this phone shows a different Online/Offline, follow the server.
      apiGet("/worker/status").then(st => { if (typeof st?.isOnline === "boolean" && Date.now() - lastToggleAt.current > 15000) setIsOnline(st.isOnline); }).catch(() => {});
      const data = await apiGet(`/bookings/worker/${user.id}`);
      if (Array.isArray(data)) {
        const list = data.map(normalizeBooking);
        // Notify the worker about NEW incoming requests (the first load only records what exists)
        const pendingIds = list.filter(b => b.status === "pending_acceptance").map(b => String(b.id));
        if (seenReqIds.current === null) {
          seenReqIds.current = new Set(pendingIds);
        } else {
          const fresh = pendingIds.filter(id => !seenReqIds.current.has(id));
          fresh.forEach(id => seenReqIds.current.add(id));
          if (fresh.length) pushNotif("New job request 🔔", fresh.length === 1 ? "A customer needs a worker. Open the app to accept." : `${fresh.length} new job requests are waiting.`);
        }
        setAllJobs(list);
      }
    } catch {
      // Keep showing the last known jobs instead of wiping the list on a blip.
    }
    setLoadingJobs(false);
  }
  useEffect(() => {
    loadJobs();
    const t = setInterval(loadJobs, 8000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Real, server-derived views of this worker's jobs.
  // "pending_acceptance" = broadcast received, not yet taken by anyone → show as incoming request
  // "assigned" = this worker accepted it → show in active jobs
  const accepted = allJobs.filter(r => ["assigned","on_way","in_progress","completed","paid"].includes(r.status) && String(r.workerId) === String(user.id)).map(r => ({
    ...r, status: ["completed","paid"].includes(r.status) ? "completed" : "accepted",
    jobName: r.items?.map(itemLabel).join(", ") || "Service request", amount: r.jobTotal,
    platformFee: r.workerDeduction, customerFee: r.platformFee, rawStatus: r.status, dateStr: r.date,
    // A job belongs to the day it was COMPLETED (older jobs without that stamp fall back to the booking day)
    dateISO: localDateKey(r.completedAt || r.createdAt),
    completedAt: ["completed","paid"].includes(r.status) ? (r.completedAt ? new Date(r.completedAt).toLocaleString("en-IN") : "") : undefined,
  }));

  // A worker with a job in "assigned"/"on_way"/"in_progress" is already busy —
  // they must finish (or the customer must cancel) before taking anything new.
  // Previously new pending_acceptance requests kept showing up regardless, so
  // a worker mid-job could accept a second job on top of the first.
  const hasActiveJob = accepted.some(r => r.status === "accepted");

  const requests = hasActiveJob ? [] : allJobs.filter(r => r.status === "pending_acceptance").map(r => ({
    ...r, status: "pending",
    jobName: r.items?.map(itemLabel).join(", ") || "Service request", amount: r.jobTotal,
    customerAvatar: (r.customerName||"C").slice(0,2).toUpperCase(), address: r.address, time: "",
  }));

  // A job the customer marked "Cash on Completion" for — could have happened
  // before OR after this job was completed. Either way, until this worker says
  // yes/no, the customer's app shows "waiting" and money is not counted as paid.
  // Once denied, cashConfirmed becomes false and paymentMethod is cleared on the
  // server, so it naturally drops out of this list until the customer picks
  // cash again (at which point it's a fresh ask).
  const cashConfirmNeeded = accepted.find(r =>
    r.status === "completed" && r.paymentMethod === "cash" && !r.paid && r.cashConfirmed !== false
  );

  async function confirmCashReceived(job, received) {
    try {
      const payload = received
        ? { paid: true, cashConfirmed: true, paymentLabel: "Cash" }
        : { paid: false, cashConfirmed: false, paymentMethod: null, paymentLabel: null };
      const res = await apiPatch(`/bookings/${job.id}`, payload);
      const updated = normalizeBooking(res.booking);
      setAllJobs(prev => prev.map(j => j.id === updated.id ? updated : j));
      setToast(received
        ? { msg: "✅ Marked as paid.", color: C.green }
        : { msg: "Customer will need to pay again.", color: C.amber });
    } catch (e) {
      setToast({ msg: "⚠️ Could not update payment status. Try again.", color: C.red });
    }
  }


  // Withdrawal state + history
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [upiId, setUpiId] = useState(() => localStorage.getItem("pt_upi_"+initialUser.id)||"");
  // Withdrawals now live on the server so the admin can see and pay them.
  const [withdrawHistory, setWithdrawHistory] = useState([]);
  const [duesPaid, setDuesPaid] = useState(0);
  const [duesPending, setDuesPending] = useState(0);
  const prevWdStatus = useRef(null);
  const mapWd = w => ({
    ...w,
    id: "WD" + String(w._id).slice(-6).toUpperCase(),
    date: new Date(w.createdAt).toLocaleDateString("en-IN"),
    time: new Date(w.createdAt).toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" }),
  });
  async function loadWithdrawals() {
    try {
      const data = await apiGet(`/withdrawals/worker/${user.id}`);
      if (!Array.isArray(data)) return;
      setDuesPaid(data.filter(w => w.kind === "dues" && w.status === "paid").reduce((s, w) => s + (Number(w.amount) || 0), 0));
      setDuesPending(data.filter(w => w.kind === "dues" && w.status === "requested").reduce((s, w) => s + (Number(w.amount) || 0), 0));
      const list = data.filter(w => w.kind !== "dues").map(mapWd);
      if (prevWdStatus.current) {
        list.forEach(w => {
          if (prevWdStatus.current[w._id] !== "requested") return;
          if (w.status === "paid") {
            pushNotif("Withdrawal Paid ✅", `₹${w.amount} was sent to ${w.upi}.`);
            setToast({ msg:`✅ Withdrawal of ₹${w.amount} paid.`, color:C.green });
          } else if (w.status === "rejected") {
            pushNotif("Withdrawal Rejected ❌", w.adminNote || `Your ₹${w.amount} request was rejected.`);
            setToast({ msg:`❌ Withdrawal of ₹${w.amount} rejected.`, color:C.red });
          }
        });
      }
      prevWdStatus.current = Object.fromEntries(list.map(w => [w._id, w.status]));
      setWithdrawHistory(list);
    } catch {}
  }
  useEffect(() => {
    loadWithdrawals();
    const t = setInterval(loadWithdrawals, 8000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Calendar view
  const [showCalendar, setShowCalendar] = useState(false);
  const [calMonth, setCalMonth] = useState(() => new Date());

  const svcColor = user.workerType ? (SERVICES[user.workerType]?.color || C.amber) : C.amber;
  const svcIcon  = user.workerType ? (SERVICES[user.workerType]?.icon  || "🔧")    : "🔧";

  const pendingCount = requests.length;
  // Lifetime earnings: sum of workerNet (jobTotal − ₹15) for completed/paid jobs.
  // This is a historical total and should NEVER shrink — it's what "Total Earned"
  // on the dashboard shows. Includes cash jobs too, since the worker DID earn
  // that money — they just already have it in hand rather than on the platform.
  const totalEarned  = allJobs.filter(r=>["completed","paid"].includes(r.status)).reduce((s,r)=>s+(r.workerNet ?? (r.jobTotal-15)),0);
  const jobsDone     = allJobs.filter(r=>["completed","paid"].includes(r.status)).length;
  const PLATFORM_DEDUCT = 15;

  // Bug fix #1: the withdraw tab was showing `totalEarned` (lifetime earnings) as the
  // "Available Balance" — money already withdrawn was never subtracted, so the
  // balance only ever grew, even right after a successful withdrawal.
  //
  // Bug fix #2: for a CASH job, the customer pays the worker directly, in person,
  // for the FULL amount — jobTotal + the ₹20 platform markup. That means the
  // worker is physically holding the platform's full ₹35 cut (₹20 customer fee +
  // ₹15 worker deduction) per cash job, money that never touched the platform.
  // So it's not enough to just leave cash earnings out of the withdrawable pool —
  // the worker actually OWES the platform ₹35 per confirmed cash job, and that
  // needs to be actively recovered from their other (online) earnings before
  // anything is withdrawable. Otherwise the worker walks away ₹35 ahead on every
  // cash job with no way for the platform to ever collect its cut back.
  const CASH_PLATFORM_CUT = 35; // ₹20 customer fee + ₹15 worker deduction, collected by the worker in cash
  const withdrawableEarned = allJobs
    .filter(r => r.paid === true && r.paymentMethod !== "cash")
    .reduce((s,r) => s + (r.workerNet ?? (r.jobTotal-15)), 0);
  const cashJobsConfirmed      = allJobs.filter(r => r.paymentMethod === "cash" && r.cashConfirmed === true);
  const cashJobsConfirmedCount = cashJobsConfirmed.length;
  // per job, so fee-free trial jobs owe nothing
  const platformOwedFromCash   = Math.max(0, cashJobsConfirmed.reduce((s,r) => s + ((r.platformFee ?? 20) + (r.workerDeduction ?? 15)), 0) - duesPaid);
  const totalWithdrawn   = withdrawHistory.filter(w => w.status !== "rejected").reduce((s,w) => s + (Number(w.amount) || 0), 0);
  const availableBalance = Math.max(0, withdrawableEarned - totalWithdrawn - platformOwedFromCash);
  const duesOutstanding  = Math.max(0, platformOwedFromCash - Math.max(0, withdrawableEarned - totalWithdrawn));   // still owed after using online earnings
  const CASH_DUES_LIMIT  = 200;

  async function handleWorkerUpdateUser(updated) {
    // ProfileEditModal already called the backend — just sync state & localStorage here
    const token = initialUser?.token || updated.token;
    const toSave = { ...updated, token: undefined };
    setUser({ ...updated, token });
    localStorage.setItem("pt_user", JSON.stringify(toSave));
    if (onUpdateUser) onUpdateUser({ ...updated, token });
    setToast({ msg:"✅ Profile updated!", color:C.green });
  }

  async function toggleOnline() {
    const next = !isOnline;
    lastToggleAt.current = Date.now();
    setIsOnline(next); // optimistic
    try {
      await apiPatch(`/workers/${user.id}/online`, { isOnline: next });
    } catch {
      setIsOnline(!next); // revert on failure
      setToast({ msg:"⚠️ Could not update availability. Try again.", color:C.red });
    }
  }

  async function acceptRequest(req) {
    if (hasActiveJob) {
      setToast({ msg:"⚠️ Finish your current job before accepting a new one.", color:C.amber });
      setSelReq(null);
      return;
    }
    try {
      // POST to the atomic /accept endpoint — only the first worker wins.
      const res = await apiPost(`/bookings/${req.id}/accept`, { workerId: user.id });
      const updated = normalizeBooking(res.booking);
      // Reload all jobs so the now-accepted booking appears in Active Jobs
      // and any other pending_acceptance copies disappear from Requests.
      setAllJobs(prev => prev.map(j => j.id === updated.id ? updated : j));
      setSelReq(null);
      setToast({ msg:"✅ Job accepted! Head to the customer's location.", color:C.green });
      pushNotif("Job Accepted", `You accepted: ${req.jobName} from ${req.customerName}`);
    } catch (e) {
      if (e.message?.includes("taken") || e.message?.includes("already been accepted")) {
        // Another worker was faster — remove this request from list
        setAllJobs(prev => prev.filter(j => j.id !== req.id));
        setSelReq(null);
        setToast({ msg:"⚡ Another worker accepted this job first.", color:C.amber });
      } else {
        setToast({ msg:"⚠️ Could not accept request. Try again.", color:C.red });
      }
    }
  }

  async function rejectRequest(req) {
    try {
      await apiPatch(`/bookings/${req.id}`, { status: "cancelled" });
      setAllJobs(prev => prev.filter(j => j.id !== req.id));
      setSelReq(null);
      setToast({ msg:"❌ Request declined.", color:C.red });
    } catch (e) {
      setToast({ msg:"⚠️ Could not decline request. Try again.", color:C.red });
    }
  }

  async function progressJob(req, patch, okMsg) {
    try {
      const res = await apiPatch(`/bookings/${req.id}`, patch);
      const updated = normalizeBooking(res.booking);
      setAllJobs(prev => prev.map(j => j.id === updated.id ? updated : j));
      setToast({ msg: okMsg, color:C.green });
    } catch (e) { setToast({ msg:"⚠️ " + (e?.message || "Could not update. Try again."), color:C.red }); }
  }

  async function completeJob(req) {
    try {
      const res = await apiPatch(`/bookings/${req.id}`, { status: "completed" });
      const updated = normalizeBooking(res.booking);
      setAllJobs(prev => prev.map(j => j.id === updated.id ? updated : j));
      setToast({ msg:"🎉 Job marked as complete! Payment will be processed.", color:C.green });
      pushNotif("Job Complete", `${req.jobName} marked done. ₹${(updated.workerNet ?? (updated.jobTotal-15))} added to earnings.`);
    } catch (e) {
      setToast({ msg:"⚠️ Could not complete job. Try again.", color:C.red });
    }
  }

  // Everything the hoisted screens need from this component
  const ctx = {
    C, PLATFORM_DEDUCT, CASH_PLATFORM_CUT, accepted, availableBalance, calMonth, cashJobsConfirmedCount,
    mapWd, platformOwedFromCash, prevWdStatus, setCalMonth, setSelJobDetail, setShowCalendar, setShowWithdraw, setUpiId,
    setWithdrawHistory, svcColor, totalWithdrawn, upiId, user, withdrawHistory, duesOutstanding, duesPending, reloadWithdrawals: loadWithdrawals, CASH_DUES_LIMIT,
  };

  const TABS = [
    { id:"requests", icon:"📨", label:t("nav_requests"), badge: pendingCount },
    { id:"active",   icon:"⚡", label:t("nav_active"),   badge: accepted.filter(r=>r.status==="accepted").length },
    { id:"earnings", icon:"💰", label:t("nav_earnings")  },
    { id:"profile",  icon:"👤", label:t("nav_profile")   },
  ];

  return (
    <div style={{ minHeight:"100vh", background:C.bg, fontFamily:"'Inter',system-ui,sans-serif", color:C.text, paddingBottom:72 }}>

      {/* Header */}
      <div style={{ background:C.card, borderBottom:"1px solid "+C.border, padding:"10px 16px", position:"sticky", top:0, zIndex:50 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <Av initials={user.avatar} color={svcColor} size={32} photo={user.photo}/>
              <span style={{ color:C.text, fontWeight:900, fontSize:16 }}>{user.name}</span>
              <span style={{ background:svcColor+"22", color:svcColor, fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:10 }}>
                {SERVICES[user.workerType]?.label || t("worker")}
              </span>
            </div>
            <div style={{ color:C.muted, fontSize:11, marginTop:2 }}>📍 {user.location || "Surat"}</div>
          </div>
          {/* Right side: online toggle */}
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {/* Online/Offline toggle */}
            <div onClick={toggleOnline} style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", padding:"7px 12px", background: isOnline ? C.green+"22" : C.card2, borderRadius:20, border:"1.5px solid "+(isOnline?C.green:C.border) }}>
              <div style={{ width:9, height:9, borderRadius:"50%", background: isOnline ? C.green : C.muted }}/>
              <span style={{ color: isOnline ? C.green : C.muted, fontWeight:700, fontSize:12 }}>
                {isOnline ? t("online") : t("offline")}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ minHeight:"calc(100vh - 120px)" }}>

        {/* ── REQUESTS TAB ── */}
        {tab==="requests" && (
          <div style={{ padding:20, maxWidth:480, margin:"0 auto" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
              <h2 style={{ color:C.text, margin:0, fontWeight:900, fontSize:22 }}>{t("incoming_requests")}</h2>
              {pendingCount>0 && <span style={{ background:C.red, color:"#fff", fontWeight:800, fontSize:12, padding:"4px 12px", borderRadius:20 }}>{pendingCount} new</span>}
            </div>

            {isOnline && locConsent === "" && (
              <div style={{ position:"fixed", inset:0, zIndex:400, background:"rgba(0,0,0,0.6)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
                <div style={{ background:C.card, border:`1.5px solid ${C.border}`, borderRadius:18, padding:22, maxWidth:380 }}>
                  <div style={{ fontSize:34, textAlign:"center" }}>📍</div>
                  <div style={{ color:C.text, fontWeight:900, fontSize:17, textAlign:"center", margin:"8px 0 10px" }}>Use your location to get nearby jobs first?</div>
                  <div style={{ color:C.sub, fontSize:13, lineHeight:1.6 }}>
                    While you are <b>online</b> and the app is open, ProWorkers uses your location so new jobs within about 3 km reach you first.
                    <ul style={{ margin:"10px 0 0", paddingLeft:18 }}>
                      <li>Only your <b>latest</b> position is kept, never a history.</li>
                      <li>It is <b>deleted</b> when you go offline or log out.</li>
                      <li>Customers <b>never see</b> it before you accept their job.</li>
                    </ul>
                    <div style={{ marginTop:10 }}>Without it you still get every job, about 2 minutes later.</div>
                  </div>
                  <div style={{ display:"flex", gap:10, marginTop:16 }}>
                    <button onClick={() => answerLoc("no")} style={{ flex:1, padding:"12px 0", background:C.card2, color:C.muted, border:`1px solid ${C.border}`, borderRadius:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>Not now</button>
                    <button onClick={() => answerLoc("yes")} style={{ flex:1, padding:"12px 0", background:svcColor, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, cursor:"pointer", fontFamily:"inherit" }}>Allow</button>
                  </div>
                </div>
              </div>
            )}
            {isOnline && locConsent !== "" && (
              <div onClick={() => locConsent === "no" && answerLoc("yes")} style={{ background:C.card2, border:`1px solid ${locConsent === "yes" && locOk ? C.green + "55" : C.border}`, borderRadius:12, padding:"10px 14px", marginBottom:12, fontSize:12, color:C.muted, cursor: locConsent === "no" ? "pointer" : "default" }}>
                {locConsent === "yes" && locOk && <span><b style={{ color:C.green }}>📍 Location on.</b> You see jobs within 3 km first.</span>}
                {locConsent === "yes" && !locOk && <span><b>📍 Getting your location…</b> If this stays, allow location for ProWorkers in phone settings. Until then you get new jobs after about 2 minutes.</span>}
                {locConsent === "no" && <span><b>📍 Location off.</b> You get new jobs about 2 minutes after nearby workers. <u>Tap to turn on.</u></span>}
              </div>
            )}

            {!isOnline && (
              <div style={{ background:C.card2, border:"1.5px solid "+C.border, borderRadius:14, padding:20, textAlign:"center", marginBottom:16 }}>
                <div style={{ fontSize:36, marginBottom:8 }}>😴</div>
                <div style={{ color:C.muted, fontWeight:700 }}>{t("offline")}</div>
                <div style={{ color:C.muted, fontSize:13, marginTop:4 }}>{t("toggle_online_hint") || "Toggle online to receive requests"}</div>
              </div>
            )}

            {isOnline && hasActiveJob && (
              <div style={{ textAlign:"center", padding:"60px 0" }}>
                <div style={{ fontSize:48, marginBottom:12 }}>🔧</div>
                <div style={{ color:C.text, fontWeight:800, fontSize:16 }}>You're currently on a job</div>
                <div style={{ color:C.muted, fontSize:13, marginTop:4 }}>New requests are paused until you complete your active job. Check the Active tab.</div>
              </div>
            )}

            {isOnline && !hasActiveJob && requests.length === 0 && (
              <div style={{ textAlign:"center", padding:"60px 0" }}>
                <div style={{ fontSize:48, marginBottom:12 }}>📭</div>
                <div style={{ color:C.text, fontWeight:800, fontSize:16 }}>{t("no_requests_now")}</div>
                <div style={{ color:C.muted, fontSize:13, marginTop:4 }}>{t("new_requests_appear")}</div>
              </div>
            )}

            {isOnline && !hasActiveJob && requests.map(req => (
              <div key={req.id} style={{ background:C.card, border:"1.5px solid "+(req.status==="accepted"?C.green+"55":svcColor+"33"), borderRadius:18, padding:18, marginBottom:14, cursor:req.status==="pending"?"pointer":"default" }}
                onClick={() => req.status==="pending" && setSelReq(req)}>

                {/* Top row */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:44, height:44, borderRadius:"50%", background:svcColor+"22", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:15, color:svcColor, flexShrink:0 }}>{req.customerAvatar}</div>
                    <div>
                      <div style={{ color:C.text, fontWeight:700, fontSize:15 }}>{req.customerName}</div>
                      <div style={{ color:C.muted, fontSize:12 }}>📞 {req.customerPhone}</div>
                    </div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ color:svcColor, fontWeight:900, fontSize:18 }}>₹{req.amount}</div>
                    <div style={{ color:C.muted, fontSize:11, marginTop:2 }}>{req.time}</div>
                  </div>
                </div>

                {/* Job details */}
                <div style={{ background:C.card2, borderRadius:10, padding:"10px 14px", marginBottom:12 }}>
                  <div style={{ color:C.text, fontWeight:700, fontSize:14 }}>{svcIcon} {req.jobName}</div>
                  <div style={{ color:C.muted, fontSize:12, marginTop:4 }}>📍 {req.address}</div>
                  {req.scheduledFor && <div style={{ color:C.amber, fontSize:12, fontWeight:800, marginTop:4 }}>📅 For {new Date(req.scheduledFor).toLocaleString("en-IN", { weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })}</div>}
                  <div style={{ display:"flex", gap:10, marginTop:8 }}>
                    <span style={{ background:C.card, color:C.blue, fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:10 }}>📏 {req.distance}</span>
                    <span style={{ background:req.urgency==="now"?C.red+"22":C.amber+"22", color:req.urgency==="now"?C.red:C.amber, fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:10 }}>
                      {req.urgency==="now"?"🔴 Urgent":req.urgency==="today"?"🟡 Today":"🟢 Tomorrow"}
                    </span>
                  </div>
                </div>

                {/* Action buttons — only on pending */}
                {req.status==="pending" && (
                  <div style={{ display:"flex", gap:10 }}>
                    <button onClick={e => { e.stopPropagation(); rejectRequest(req); }} style={{ flex:1, padding:"12px 0", background:C.red+"18", color:C.red, border:"1.5px solid "+C.red+"44", borderRadius:12, fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>
                      ✗ {t("decline")}
                    </button>
                    <button onClick={e => { e.stopPropagation(); acceptRequest(req); }} style={{ flex:2, padding:"12px 0", background:C.green, color:"#fff", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>
                      ✓ {t("accept")}
                    </button>
                  </div>
                )}

                {req.status==="accepted" && (
                  <div style={{ textAlign:"center", padding:"6px 0", color:C.green, fontWeight:700, fontSize:13 }}>✅ {t("accepted_head_to_location") || "Accepted — head to location"}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── ACTIVE JOBS TAB ── */}
        {tab==="active" && (
          <div style={{ padding:20, maxWidth:480, margin:"0 auto" }}>
            <h2 style={{ color:C.text, margin:"0 0 18px", fontWeight:900, fontSize:22 }}>{t("active_jobs")}</h2>
            {accepted.filter(r=>r.status==="accepted").length===0 && (
              <div style={{ textAlign:"center", padding:"60px 0" }}>
                <div style={{ fontSize:48, marginBottom:12 }}>🏁</div>
                <div style={{ color:C.text, fontWeight:800, fontSize:16 }}>{t("no_active_jobs")}</div>
                <div style={{ color:C.muted, fontSize:13, marginTop:4 }}>{t("accepted_requests_appear")}</div>
              </div>
            )}
            {accepted.filter(r=>r.status==="accepted").map(req => (
              <div key={req.id} style={{ background:C.card, border:"2px solid "+C.green+"55", borderRadius:18, padding:18, marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                  <div>
                    <div style={{ color:C.text, fontWeight:800, fontSize:16 }}>{req.jobName}</div>
                    <div style={{ color:C.muted, fontSize:12, marginTop:2 }}>{t("customer")}: {req.customerName}</div>
                  </div>
                  <div style={{ color:svcColor, fontWeight:900, fontSize:20 }}>₹{req.amount}</div>
                </div>
                <div style={{ background:C.card2, borderRadius:10, padding:"10px 14px", marginBottom:14 }}>
                  <div style={{ color:C.muted, fontSize:12 }}>📍 {req.address}</div>
                  {req.scheduledFor && <div style={{ color:C.amber, fontSize:12, fontWeight:800, marginTop:4 }}>📅 For {new Date(req.scheduledFor).toLocaleString("en-IN", { weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })}</div>}
                  <div style={{ color:C.muted, fontSize:12, marginTop:4 }}>📞 {req.customerPhone}</div>
                  <div style={{ color:C.muted, fontSize:12, marginTop:4 }}>✅ {req.acceptedAt}</div>
                  <ContactBar phone={req.customerPhone} name={req.customerName?.split(" ")[0]} onChat={() => setChatJob(req)} C={C}/>
                  <a href={navLink(req)} target="_blank" rel="noopener noreferrer" style={{ display:"block", textAlign:"center", textDecoration:"none", marginTop:10, background:C.blue+"22", border:`1px solid ${C.blue}`, color:C.blue, borderRadius:10, padding:"10px 0", fontWeight:800, fontSize:13 }}>
                    🧭 Navigate to customer{req.coords ? "" : " (address search)"}
                  </a>
                </div>
                {req.rawStatus === "assigned" && (
                  <button onClick={() => progressJob(req, { status:"on_way" }, "🚗 Customer notified you're on the way.")} style={{ width:"100%", padding:"14px 0", background:C.blue, color:"#fff", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit", marginBottom:10 }}>
                    🚗 I'm on my way
                  </button>
                )}
                {req.rawStatus === "on_way" && !req.arrivedAt && (
                  <ArriveButton req={req} C={C} onTap={() => progressJob(req, { arrived:true }, "📍 Customer told you've arrived.")}/>
                )}
                {req.arrivedAt && <div style={{ color:C.green, fontSize:12, fontWeight:700, textAlign:"center", marginBottom:10 }}>✓ Arrived · customer notified</div>}
                <button onClick={() => completeJob(req)} style={{ width:"100%", padding:"14px 0", background:C.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}>
                  🎉 {t("mark_complete")}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── EARNINGS TAB ── */}
        {tab==="earnings" && (
          <div style={{ padding:20, maxWidth:480, margin:"0 auto" }}>
            <h2 style={{ color:C.text, margin:"0 0 18px", fontWeight:900, fontSize:22 }}>{t("my_earnings")}</h2>

            {/* Stats */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
              {[
                ["₹"+totalEarned.toLocaleString("en-IN"), t("total_earned"), C.amber],
                [String(jobsDone), t("jobs_done"), C.green],
                [String(accepted.filter(r=>r.status==="accepted").length), t("in_progress"), C.blue],
                [String(requests.filter(r=>r.status==="pending").length), t("pending"), C.red],
              ].map(([val,label,col]) => (
                <div key={label} style={{ background:C.card, border:"1px solid "+C.border, borderRadius:14, padding:18, textAlign:"center" }}>
                  <div style={{ color:col, fontWeight:900, fontSize:24 }}>{val}</div>
                  <div style={{ color:C.muted, fontSize:10, marginTop:4, letterSpacing:0.5 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Last 7 days */}
            {(() => {
              const days = [];
              for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i*86400000); days.push({ key: localDateKey(d), label: d.toLocaleDateString("en-IN", { weekday:"short" }).slice(0,3), amt: 0 }); }
              allJobs.filter(r => ["completed","paid"].includes(r.status)).forEach(r => { const d = days.find(x => x.key === r.dateISO); if (d) d.amt += (r.workerNet ?? 0); });
              const max = Math.max(1, ...days.map(d => d.amt));
              const week = days.reduce((a, d) => a + d.amt, 0);
              return (
                <div style={{ background:C.card, border:"1px solid "+C.border, borderRadius:14, padding:16, marginBottom:16 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:12 }}>
                    <span style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1 }}>LAST 7 DAYS</span>
                    <span style={{ color:C.green, fontWeight:900, fontSize:16 }}>₹{week.toLocaleString("en-IN")}</span>
                  </div>
                  <div style={{ display:"flex", alignItems:"flex-end", gap:6, height:90 }}>
                    {days.map(d => (
                      <div key={d.key} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"flex-end", height:"100%" }}>
                        <div style={{ color:C.muted, fontSize:9, marginBottom:2 }}>{d.amt ? "₹"+d.amt : ""}</div>
                        <div style={{ width:"100%", height: Math.max(3, Math.round(d.amt/max*60)), background: d.amt ? C.green : C.border, borderRadius:4 }}/>
                        <div style={{ color:C.muted, fontSize:10, marginTop:4 }}>{d.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Action buttons */}
            <div style={{ display:"flex", gap:10, marginBottom:20 }}>
              <button onClick={()=>setShowWithdraw(true)} style={{ flex:1, padding:"13px 0", background:C.amber, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>
                {t("withdraw_to_upi")}
              </button>
              <button onClick={()=>setShowCalendar(true)} style={{ flex:1, padding:"13px 0", background:C.card2, color:C.text, border:`1.5px solid ${C.border}`, borderRadius:12, fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>
                {t("calendar")}
              </button>
            </div>

            {/* Completed jobs list */}
            <div style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:4 }}>{t("completed_jobs")} · TODAY</div>
            <div style={{ color:C.muted, fontSize:11, marginBottom:12 }}>Older jobs are in the 📅 Calendar.</div>
            {accepted.filter(r=>r.status==="completed" && r.dateISO===localDateKey(new Date())).length===0 && (
              <div style={{ color:C.muted, textAlign:"center", padding:36, fontSize:14 }}>No jobs completed today.</div>
            )}
            {accepted.filter(r=>r.status==="completed" && r.dateISO===localDateKey(new Date())).map(req => (
              <div key={req.id} onClick={() => setSelJobDetail(req)} style={{ background:C.card, border:"1px solid "+C.border, borderRadius:14, padding:16, marginBottom:10, cursor:"pointer" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <div style={{ color:C.text, fontWeight:700 }}>{req.jobName}</div>
                    <div style={{ color:C.muted, fontSize:12, marginTop:3 }}>{req.customerName} · {req.dateStr || req.acceptedAt}</div>
                    <div style={{ color:C.muted, fontSize:11, marginTop:2 }}>📍 {req.address}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ color:C.green, fontWeight:900, fontSize:17 }}>₹{req.amount}</div>
                    <div style={{ color:C.muted, fontSize:10, marginTop:4 }}>{t("tap_for_details")}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── PROFILE TAB ── */}
        {tab==="profile" && (
          <WorkerProfileTab
            user={user}
            svcColor={svcColor}
            svcIcon={svcIcon}
            C={C}
            onEditProfile={() => setShowEdit(true)}
            onLogout={onLogout}
          />
        )}
      </div>

      {/* Bottom nav */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, background:C.card, borderTop:"1px solid "+C.border, display:"flex", zIndex:50 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ flex:1, padding:"10px 0 8px", background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", position:"relative" }}>
            <div style={{ fontSize:18 }}>{t.icon}</div>
            <div style={{ fontSize:9, fontWeight:700, color:tab===t.id?svcColor:C.muted, marginTop:2 }}>{t.label}</div>
            {tab===t.id && <div style={{ height:2, background:svcColor, borderRadius:1, margin:"4px auto 0", width:20 }}/>}
            {t.badge>0 && (
              <div style={{ position:"absolute", top:6, right:"calc(50% - 18px)", background:C.red, color:"#fff", fontSize:9, fontWeight:800, width:16, height:16, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center" }}>
                {t.badge}
              </div>
            )}
          </button>
        ))}
      </div>

      {toast && <Toast msg={toast.msg} color={toast.color} onDone={() => setToast(null)}/>}
      {showWithdraw && <WithdrawModal ctx={ctx}/>}
      {showCalendar && <CalendarView ctx={ctx}/>}
      {showEdit && <ProfileEditModal user={user} onSave={u => { handleWorkerUpdateUser(u); setShowEdit(false); }} onClose={() => setShowEdit(false)} C={C}/>}
      {chatJob && <ChatModal booking={chatJob} meRole="worker" otherName={chatJob.customerName} otherPhone={chatJob.customerPhone} C={C} onClose={() => setChatJob(null)}/>}
      {selJobDetail && <WorkerJobDetailModal job={selJobDetail} C={C} svcColor={svcColor} svcIcon={svcIcon} onClose={() => setSelJobDetail(null)}/>}
      {cashConfirmNeeded && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.82)", zIndex:500, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:C.card, borderRadius:20, padding:26, width:"100%", maxWidth:390, border:`1px solid ${C.border}`, textAlign:"center" }}>
            <div style={{ fontSize:48 }}>💵</div>
            <div style={{ color:C.text, fontWeight:900, fontSize:18, marginTop:10 }}>Did you receive cash?</div>
            <div style={{ color:C.muted, fontSize:13, marginTop:8, lineHeight:1.5 }}>
              {cashConfirmNeeded.customerName || "The customer"} chose to pay in cash for "{cashConfirmNeeded.jobName}". Confirm you actually received it before it's marked as paid.
            </div>
            <div style={{ background:C.card2, borderRadius:12, padding:"12px 14px", marginTop:14, fontSize:13, textAlign:"left" }}>
              <div style={{ display:"flex", justifyContent:"space-between", color:C.muted }}><span>Service charge (your work)</span><span>₹{cashConfirmNeeded.jobTotal}</span></div>
              <div style={{ display:"flex", justifyContent:"space-between", color:C.amber, marginTop:4 }}><span>Customer's platform charges</span><span>+₹{cashConfirmNeeded.customerFee ?? 0}</span></div>
              <div style={{ display:"flex", justifyContent:"space-between", color:C.text, fontWeight:900, fontSize:16, marginTop:8, paddingTop:8, borderTop:`1px solid ${C.border}` }}><span>Collect from customer</span><span>₹{cashConfirmNeeded.total}</span></div>
              <div style={{ color:C.muted, fontSize:11, marginTop:8, lineHeight:1.4 }}>After you confirm, ₹{(cashConfirmNeeded.customerFee ?? 0) + 15} (platform charges + ₹15 your fee) is deducted from your ProWorkers balance. You keep ₹{(cashConfirmNeeded.jobTotal||0) - 15}.</div>
            </div>
            <div style={{ display:"flex", gap:10, marginTop:20 }}>
              <button onClick={() => confirmCashReceived(cashConfirmNeeded, false)} style={{ flex:1, padding:"13px 0", background:C.card2, color:C.text, border:`1px solid ${C.border}`, borderRadius:12, fontWeight:800, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>
                Not Yet
              </button>
              <button onClick={() => confirmCashReceived(cashConfirmNeeded, true)} style={{ flex:1, padding:"13px 0", background:C.green, color:"#0D1117", border:"none", borderRadius:12, fontWeight:800, fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>
                Yes, Received ✓
              </button>
            </div>
          </div>
        </div>
      )}
      {showNotifBanner && <NotificationBanner C={C} onDismiss={(granted) => { setShowNotifBanner(false); if(granted) pushNotif("ProWorkers Notifications On", "You'll get alerts for bookings, payments & more."); }}/>}
    </div>
  );
}

// ── Admin Dashboard ────────────────────────────────────────────────────────────
const API = (path, opts={}) =>
  fetch(`${API_BASE}${path}`, { headers:{ "Content-Type":"application/json", ...((opts.token || localStorage.getItem("pt_token")) ? { Authorization:`Bearer ${opts.token || localStorage.getItem("pt_token")}` } : {}) }, ...opts })
    .then(r => r.json());

function StatCard({ icon, label, value, sub, color, C }) {
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"16px 18px", flex:1, minWidth:140 }}>
      <div style={{ fontSize:24, marginBottom:6 }}>{icon}</div>
      <div style={{ fontSize:26, fontWeight:800, color: color||C.text }}>{value}</div>
      <div style={{ fontSize:12, fontWeight:700, color:C.text, marginTop:2 }}>{label}</div>
      {sub && <div style={{ fontSize:11, color:C.muted, marginTop:3 }}>{sub}</div>}
    </div>
  );
}

function MiniBar({ data, C }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map(d => d.bookings || 0), 1);
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  return (
    <div style={{ display:"flex", alignItems:"flex-end", gap:4, height:60 }}>
      {data.map((d, i) => {
        const h = Math.max(4, Math.round(((d.bookings||0)/max)*52));
        const label = days[new Date(d.date+"T00:00:00").getDay()];
        return (
          <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3 }}>
            <div style={{ width:"100%", background:C.amber, borderRadius:"4px 4px 0 0", height:h, opacity:0.85 }}/>
            <div style={{ fontSize:9, color:C.muted }}>{label}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Admin: one worker's full details (jobs, calendar, earnings, amount left to pay) ──
function WorkerDetail({ workerId, C, onClose }) {
  const [data, setData]   = useState(null);
  const [err, setErr]     = useState("");
  const [month, setMonth] = useState(null);      // { y, m } (m = 0-11)
  const [selDay, setSelDay] = useState(null);    // "YYYY-MM-DD"
  const [duesAmt, setDuesAmt] = useState("");
  const [duesMsg, setDuesMsg] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  async function recordDues() {
    setDuesMsg("");
    try {
      const r = await API(`/admin/workers/${workerId}/dues-payment`, { method:"POST", body: JSON.stringify({ amount: duesAmt }) });
      if (r.error) { setDuesMsg(r.error); return; }
      setDuesAmt(""); setDuesMsg("Recorded ✓"); setReloadKey(k => k + 1);
    } catch { setDuesMsg("Could not save. Check your connection."); }
  }
  const money = n => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
  const pad = n => String(n).padStart(2, "0");

  useEffect(() => {
    let alive = true;
    API(`/admin/workers/${workerId}/summary`).then(r => {
      if (!alive) return;
      if (r.error) { setErr(r.error); return; }
      setData(r);
      const last = r.days.length ? r.days[r.days.length - 1].date : null;
      const base = last ? new Date(last + "T00:00:00") : new Date();
      setMonth({ y: base.getFullYear(), m: base.getMonth() });
    }).catch(() => alive && setErr("Could not load this worker. Check your connection."));
    return () => { alive = false; };
  }, [workerId, reloadKey]);

  const shell = (children) => (
    <div style={{ position:"fixed", inset:0, zIndex:300, background:C.bg, color:C.text, overflowY:"auto", fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={{ position:"sticky", top:0, background:C.card, borderBottom:`1px solid ${C.border}`, padding:"12px 16px", display:"flex", alignItems:"center", gap:12, zIndex:2 }}>
        <button onClick={onClose} style={{ background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:10, padding:"6px 12px", cursor:"pointer", fontWeight:700, fontSize:13 }}>← Back</button>
        <div style={{ fontWeight:800, fontSize:15 }}>Worker details</div>
      </div>
      <div style={{ maxWidth:760, margin:"0 auto", padding:"16px 16px 60px" }}>{children}</div>
    </div>
  );

  if (err)   return shell(<div style={{ color:C.red, padding:20, textAlign:"center" }}>⚠️ {err}</div>);
  if (!data) return shell(<div style={{ color:C.muted, padding:40, textAlign:"center" }}>⏳ Loading…</div>);

  const { worker: w, totals: t, days, jobs, withdrawals } = data;
  const dayMap = {}; days.forEach(d => { dayMap[d.date] = d; });
  const first = new Date(month.y, month.m, 1);
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const cells = [...Array(first.getDay()).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const keyOf = d => `${month.y}-${pad(month.m + 1)}-${pad(d)}`;
  const monthRows = days.filter(d => d.date.startsWith(`${month.y}-${pad(month.m + 1)}-`));
  const mJobs = monthRows.reduce((a, d) => a + d.jobs, 0);
  const mEarn = monthRows.reduce((a, d) => a + d.earned, 0);
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone:"Asia/Kolkata" });
  const shiftMonth = k => { const d = new Date(month.y, month.m + k, 1); setMonth({ y:d.getFullYear(), m:d.getMonth() }); setSelDay(null); };
  const monthName = first.toLocaleDateString("en-IN", { month:"long", year:"numeric" });
  const shownJobs = selDay ? jobs.filter(j => j.date === selDay) : jobs.filter(j => j.date.startsWith(`${month.y}-${pad(month.m + 1)}-`));
  const sColor = s => ({ completed:C.green, paid:C.green, cancelled:C.red, in_progress:C.blue, on_way:C.blue, assigned:C.amber }[s] || C.muted);
  const box = { background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"14px 16px", marginBottom:14 };
  const Stat = ({ label, value, sub, color, big }) => (
    <div style={{ background:C.card, border:`1px solid ${color ? color + "55" : C.border}`, borderRadius:12, padding:"12px 14px" }}>
      <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:.3 }}>{label}</div>
      <div style={{ fontSize: big ? 24 : 20, fontWeight:900, color: color || C.text, marginTop:2 }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{sub}</div>}
    </div>
  );

  return shell(<>
    {/* Who */}
    <div style={box}>
      <div style={{ fontWeight:900, fontSize:18 }}>{({ electrician:"⚡", plumber:"🔧", labour:"👷" }[w.workerType] || "🛠️")} {w.name}</div>
      <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>{w.email} · {w.phone}</div>
      <div style={{ fontSize:12, marginTop:8, display:"flex", gap:14, flexWrap:"wrap" }}>
        <span style={{ color:C.amber, fontWeight:700 }}>{w.workerType}</span>
        <span>📍 {w.area || w.location || "—"}</span>
        <span>⭐ {w.rating || "—"}</span>
        <span>Trust {w.trust}%</span>
        <span>Joined {new Date(w.createdAt).toLocaleDateString("en-IN")}</span>
      </div>
    </div>

    {/* Money: the main answer — how much is left to pay */}
    <div style={{ ...box, border:`1.5px solid ${t.remainingToPay > 0 ? C.amber : C.border}`, textAlign:"center" }}>
      <div style={{ fontSize:12, color:C.muted, fontWeight:700, letterSpacing:.5 }}>STILL TO PAY THIS WORKER</div>
      <div style={{ fontSize:34, fontWeight:900, color: t.remainingToPay > 0 ? C.amber : C.green, marginTop:2 }}>{money(t.remainingToPay)}</div>
      {t.workerOwes > 0 && <div style={{ fontSize:12, color:C.red, marginTop:4 }}>Worker has to pay us {money(t.workerOwes)} (cash jobs)</div>}
      {(t.cashDues - (t.duesPaid||0)) > 0 && (
        <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${C.border}`, textAlign:"left" }}>
          <div style={{ fontSize:12, color:C.muted }}>Our fee from cash jobs {money(t.cashDues)} · worker paid {money(t.duesPaid||0)}. Worker gets no new jobs if more than {money(t.duesLimit)} is still unpaid.</div>
          <div style={{ display:"flex", gap:8, marginTop:8 }}>
            <input value={duesAmt} onChange={e => setDuesAmt(e.target.value.replace(/\D/g,""))} placeholder="₹ received from worker" inputMode="numeric" style={{ flex:1, background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:10, padding:"10px 12px", fontSize:14, fontFamily:"inherit" }}/>
            <button onClick={recordDues} style={{ background:C.green, color:"#0D1117", border:"none", borderRadius:10, padding:"10px 14px", fontWeight:800, cursor:"pointer", fontFamily:"inherit" }}>Record</button>
          </div>
          {duesMsg && <div style={{ fontSize:12, color: duesMsg.includes("✓") ? C.green : C.red, marginTop:6 }}>{duesMsg}</div>}
        </div>
      )}
      {t.requested > 0 && <div style={{ fontSize:12, color:C.amber, marginTop:4 }}>💸 {money(t.requested)} payout requested. See the Payouts tab to pay it.</div>}
      <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>= online earnings {money(t.onlineEarned)} − our fee from cash jobs {money(t.cashDues)} − already paid {money(t.paidOut)}</div>
    </div>

    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
      <Stat label="JOBS DONE" value={t.jobsCompleted} sub={`${t.jobsActive} active · ${t.jobsCancelled} cancelled`} color={C.green}/>
      <Stat label="WORK VALUE" value={money(t.jobValue)} sub="total of all finished jobs"/>
      <Stat label="WORKER EARNED" value={money(t.earned)} sub="after platform charges" color={C.amber}/>
      <Stat label="ALREADY PAID OUT" value={money(t.paidOut)} sub="withdrawals paid"/>
      <Stat label="CASH TAKEN DIRECTLY" value={money(t.cashCollected)} sub={`${t.cashJobs} cash job${t.cashJobs === 1 ? "" : "s"} · our fee ${money(t.cashDues)}`}/>
      <Stat label="WAITING ON CUSTOMER" value={money(t.awaitingCustomerPayment)} sub="done, customer not paid yet"/>
    </div>

    {/* Calendar */}
    <div style={box}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
        <button onClick={() => shiftMonth(-1)} style={{ background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:"4px 12px", cursor:"pointer", fontSize:16 }}>‹</button>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontWeight:800, fontSize:15 }}>{monthName}</div>
          <div style={{ fontSize:11, color:C.muted }}>{mJobs} job{mJobs === 1 ? "" : "s"} · earned {money(mEarn)}</div>
        </div>
        <button onClick={() => shiftMonth(1)} style={{ background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:"4px 12px", cursor:"pointer", fontSize:16 }}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7, 1fr)", gap:4 }}>
        {["S","M","T","W","T","F","S"].map((d, i) => <div key={i} style={{ textAlign:"center", fontSize:10, color:C.muted, fontWeight:700 }}>{d}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={i}/>;
          const k = keyOf(d), info = dayMap[k], sel = selDay === k;
          return (
            <button key={i} onClick={() => setSelDay(sel ? null : k)} style={{ minHeight:54, borderRadius:8, cursor:"pointer", fontFamily:"inherit", padding:"3px 2px",
              background: sel ? C.amber : info ? C.green + "22" : C.card2,
              border: `1px solid ${sel ? C.amber : k === todayKey ? C.blue : info ? C.green + "66" : C.border}`,
              color: sel ? "#000" : C.text, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"flex-start", gap:1 }}>
              <span style={{ fontSize:11, fontWeight:700, opacity: info ? 1 : .55 }}>{d}</span>
              {info && <span style={{ fontSize:10, fontWeight:800, color: sel ? "#000" : C.green }}>{info.jobs} job{info.jobs === 1 ? "" : "s"}</span>}
              {info && <span style={{ fontSize:9, color: sel ? "#000" : C.muted }}>{money(info.earned)}</span>}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize:10, color:C.muted, marginTop:8 }}>Green days have finished jobs. Tap a day to see them. The amount shown is the worker's share.</div>
    </div>

    {/* Jobs for the chosen day / month */}
    <div style={box}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <div style={{ fontWeight:800, fontSize:14 }}>{selDay ? `Jobs on ${new Date(selDay + "T00:00:00").toLocaleDateString("en-IN", { day:"numeric", month:"short", year:"numeric" })}` : `Jobs in ${monthName}`}</div>
        {selDay && <button onClick={() => setSelDay(null)} style={{ background:"none", border:"none", color:C.amber, cursor:"pointer", fontSize:12, fontWeight:700 }}>Show month</button>}
      </div>
      {shownJobs.length === 0 && <div style={{ color:C.muted, fontSize:13, padding:"10px 0" }}>No jobs here.</div>}
      {shownJobs.map(j => (
        <div key={j.id} style={{ padding:"10px 0", borderTop:`1px solid ${C.border}` }}>
          <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
            <div style={{ fontSize:13, fontWeight:700 }}>{j.customerName || "Customer"}</div>
            <div style={{ fontSize:13, fontWeight:800, color:C.amber }}>{money(j.workerNet)}</div>
          </div>
          <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>{j.items || "—"}</div>
          <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>📍 {j.address || "—"}</div>
          <div style={{ fontSize:11, marginTop:4, display:"flex", gap:10, flexWrap:"wrap" }}>
            <span style={{ color:sColor(j.status), fontWeight:700 }}>{j.status.replace("_", " ")}</span>
            <span style={{ color:C.muted }}>Bill {money(j.jobTotal)}</span>
            <span style={{ color: j.paid || j.cashConfirmed ? C.green : C.muted }}>{j.paymentMethod === "cash" ? (j.cashConfirmed ? "💵 cash received" : "💵 cash pending") : j.paid ? "✅ paid online" : "⏳ not paid"}</span>
          </div>
        </div>
      ))}
    </div>

    {/* Payout history */}
    <div style={box}>
      <div style={{ fontWeight:800, fontSize:14, marginBottom:8 }}>Payout history</div>
      {withdrawals.length === 0 && <div style={{ color:C.muted, fontSize:13 }}>No payouts requested yet.</div>}
      {withdrawals.map(x => (
        <div key={x._id} style={{ display:"flex", justifyContent:"space-between", gap:8, padding:"8px 0", borderTop:`1px solid ${C.border}`, fontSize:12 }}>
          <div>
            <div style={{ fontWeight:700 }}>{new Date(x.createdAt).toLocaleDateString("en-IN")} · {x.upi}</div>
            {x.payoutUtr && <div style={{ color:C.muted, fontSize:11 }}>UTR {x.payoutUtr}</div>}
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontWeight:800 }}>{money(x.amount)}</div>
            <div style={{ fontSize:11, fontWeight:700, color: x.status === "paid" ? C.green : x.status === "rejected" ? C.red : C.amber }}>{x.status}</div>
          </div>
        </div>
      ))}
    </div>
  </>);
}

// ── Calendar helpers for the admin screens ───────────────────────────────────
const istDayOf = d => d ? new Date(d).toLocaleDateString("en-CA", { timeZone:"Asia/Kolkata" }) : "";
const dayLabel = k => k ? new Date(k + "T00:00:00").toLocaleDateString("en-IN", { weekday:"short", day:"numeric", month:"short", year:"numeric" }) : "No date";
const rupee = n => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
function groupByDay(rows, getDate) {
  const m = new Map();
  rows.forEach(r => { const k = istDayOf(getDate(r)); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, list]) => ({ day, rows: list }));
}
function DayHeader({ C, day, left, right }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", margin:"16px 2px 8px", paddingBottom:6, borderBottom:`1px solid ${C.border}` }}>
      <div style={{ fontWeight:800, fontSize:13, color:C.text }}>📅 {dayLabel(day)} <span style={{ color:C.muted, fontWeight:600, fontSize:11 }}>· {left}</span></div>
      <div style={{ fontWeight:800, fontSize:13, color:C.amber }}>{right}</div>
    </div>
  );
}
// Month calendar, same look as the one on the worker details screen.
// info = { "YYYY-MM-DD": { top: "3 orders", sub: "₹1,200" } }. Green days have data.
function MonthCalendar({ C, month, onMonth, info, selected, onPick, hint }) {
  const pad = n => String(n).padStart(2, "0");
  const today = istDayOf(new Date());
  const first = new Date(month.y, month.m, 1);
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const cells = [...Array(first.getDay()).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const keyOf = d => `${month.y}-${pad(month.m + 1)}-${pad(d)}`;
  const step = k => { const d = new Date(month.y, month.m + k, 1); onMonth({ y:d.getFullYear(), m:d.getMonth() }); };
  const name = first.toLocaleDateString("en-IN", { month:"long", year:"numeric" });
  const btn = { background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:"4px 12px", cursor:"pointer", fontSize:16 };
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"14px 16px", marginBottom:14 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
        <button onClick={() => step(-1)} style={btn}>‹</button>
        <div style={{ fontWeight:800, fontSize:15 }}>{name}</div>
        <button onClick={() => step(1)} style={btn}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7, 1fr)", gap:4 }}>
        {["S","M","T","W","T","F","S"].map((d, i) => <div key={i} style={{ textAlign:"center", fontSize:10, color:C.muted, fontWeight:700 }}>{d}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={i}/>;
          const k = keyOf(d), x = info[k], sel = selected === k, future = k > today;
          return (
            <button key={i} disabled={future} onClick={() => onPick(sel ? null : k)} style={{ minHeight:54, borderRadius:8, cursor: future ? "default" : "pointer", fontFamily:"inherit", padding:"3px 2px", opacity: future ? 0.35 : 1,
              background: sel ? C.amber : x ? C.green + "22" : C.card2,
              border: `1px solid ${sel ? C.amber : k === today ? C.blue : x ? C.green + "66" : C.border}`,
              color: sel ? "#000" : C.text, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"flex-start", gap:1 }}>
              <span style={{ fontSize:11, fontWeight:700, opacity: x ? 1 : .55 }}>{d}</span>
              {x && <span style={{ fontSize:10, fontWeight:800, color: sel ? "#000" : C.green }}>{x.top}</span>}
              {x && x.sub && <span style={{ fontSize:9, color: sel ? "#000" : C.muted }}>{x.sub}</span>}
            </button>
          );
        })}
      </div>
      {hint && <div style={{ fontSize:10, color:C.muted, marginTop:8 }}>{hint}</div>}
    </div>
  );
}
// Build the day→{top,sub} map the calendar needs
function dayInfoMap(rows, getDate, noun, getAmt) {
  const m = {};
  rows.forEach(r => { const k = istDayOf(getDate(r)); if (!k) return; const x = m[k] || (m[k] = { n:0, amt:0 }); x.n++; x.amt += getAmt(r) || 0; });
  const out = {};
  Object.keys(m).forEach(k => { out[k] = { top: `${m[k].n} ${noun}${m[k].n === 1 ? "" : "s"}`, sub: rupee(m[k].amt) }; });
  return out;
}

// Day picker for Bookings / Payments / Payouts. "" means today.
// Tap the date bar to open the calendar; arrows step one day.
function DayFilter({ C, value, onChange, pending, info }) {
  const today = istDayOf(new Date());
  const day = value || today;
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => { const d = new Date(day + "T00:00:00"); return { y:d.getFullYear(), m:d.getMonth() }; });
  const shift = n => { const d = new Date(day + "T00:00:00"); d.setDate(d.getDate() + n); const k = d.toLocaleDateString("en-CA"); onChange(k >= today ? "" : k); };
  const btn = { background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:"7px 12px", fontSize:13, fontWeight:800, cursor:"pointer" };
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ display:"flex", gap:6, alignItems:"center" }}>
        <button onClick={() => shift(-1)} style={btn}>‹</button>
        <button onClick={() => setOpen(o => !o)} style={{ ...btn, flex:1, minWidth:0, textAlign:"center" }}>📅 {day === today ? "Today · " : ""}{dayLabel(day)} {open ? "▲" : "▼"}</button>
        <button onClick={() => shift(1)} disabled={day >= today} style={{ ...btn, opacity: day >= today ? 0.4 : 1 }}>›</button>
        {day !== today && <button onClick={() => onChange("")} style={{ ...btn, background:C.amber, color:"#000", border:"none" }}>Today</button>}
      </div>
      {open && (
        <div style={{ marginTop:8 }}>
          <MonthCalendar C={C} month={month} onMonth={setMonth} info={info || {}} selected={day}
            onPick={k => { onChange(!k || k >= today ? "" : k); setOpen(false); }}
            hint="Green days have entries. Tap a day to open it."/>
        </div>
      )}
      <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>{day === today ? "Showing today. Open the calendar for earlier days." : `Showing ${dayLabel(day)}`}</div>
      {pending && pending.count > 0 && (
        <div onClick={() => onChange(pending.day >= today ? "" : pending.day)} style={{ marginTop:8, background:C.amber+"22", border:`1px solid ${C.amber}66`, color:C.amber, borderRadius:8, padding:"8px 12px", fontSize:12, fontWeight:700, cursor:"pointer" }}>
          ⏳ {pending.count} {pending.label} on other days. Tap to open {dayLabel(pending.day).replace(/, \d{4}$/, "")}.
        </div>
      )}
    </div>
  );
}

// Save / share a spreadsheet (CSV opens in Excel). Web: downloads it. Android app: opens the share sheet.
async function exportCsv(filename, rows) {
  const esc = v => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = "\uFEFF" + rows.map(r => r.map(esc).join(",")).join("\r\n");
  if (Capacitor.isNativePlatform()) {
    const w = await Filesystem.writeFile({ path: filename, data: csv, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: filename, url: w.uri, dialogTitle: "Save or send this file" });
    return;
  }
  const url = URL.createObjectURL(new Blob([csv], { type:"text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Admin switch for "auto-verify UPI payments" (Android app only)
function AutoVerifyCard({ C, token }) {
  const [enabled, setEnabled] = useState(null);   // null = checking
  const native = Capacitor.isNativePlatform();
  async function check() {
    try { const r = await UpiWatcher.status(); setEnabled(!!r.enabled); } catch { setEnabled(false); }
  }
  useEffect(() => {
    if (!native) return;
    // hand the login to the listener so it can report payments even when the app is closed
    UpiWatcher.saveConfig({ token: token || "", apiBase: API_BASE }).catch(() => {});
    check();
    const on = () => check();
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const box = { background:C.card, border:`1px solid ${enabled ? C.green + "66" : C.border}`, borderRadius:12, padding:14, marginBottom:14 };
  if (!native) return (
    <div style={box}>
      <div style={{ fontWeight:800, fontSize:13 }}>⚡ Auto-verify UPI payments</div>
      <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>Works in the Android app on your phone. Open the app there to turn it on. Manual approval below always works.</div>
    </div>
  );
  return (
    <div style={box}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
        <div style={{ fontWeight:800, fontSize:13 }}>⚡ Auto-verify UPI payments</div>
        <span style={{ fontSize:11, fontWeight:800, color: enabled ? C.green : C.muted }}>{enabled === null ? "…" : enabled ? "● ON" : "○ OFF"}</span>
      </div>
      <div style={{ fontSize:11, color:C.muted, marginTop:6, lineHeight:1.5 }}>
        When your UPI app shows "money received" for the exact amount within 2 minutes of the customer tapping "I've paid", the payment is verified for you. Anything unclear stays Pending for you to approve below, as before.
      </div>
      {!enabled && (
        <>
          <button onClick={() => UpiWatcher.openSettings().catch(() => {})} style={{ marginTop:10, width:"100%", background:C.amber, border:"none", color:"#000", borderRadius:8, padding:"10px 0", fontWeight:800, fontSize:12, cursor:"pointer" }}>Turn on: allow notification access</button>
          <div style={{ fontSize:10, color:C.muted, marginTop:6, lineHeight:1.5 }}>In the list, switch on "ProWorkers". If it is greyed out: Android Settings → Apps → ProWorkers → ⋮ menu → "Allow restricted settings", then try again.</div>
        </>
      )}
      {enabled && <div style={{ fontSize:10, color:C.muted, marginTop:6 }}>Open this admin app at least once every few weeks so your login stays fresh.</div>}
    </div>
  );
}

// Full-screen calendar view for "Total platform revenue" (mode "revenue")
// and "Platform earnings" (mode "earnings": what ProWorkers keeps).
function RevenueDetail({ mode, bookings, C, onClose }) {
  const isEarn = mode === "earnings";
  const valid = useMemo(() => bookings.filter(b => b.status !== "cancelled"), [bookings]);
  const days = useMemo(() => {
    const m = {};
    valid.forEach(b => {
      const k = istDayOf(b.createdAt); if (!k) return;
      const d = m[k] || (m[k] = { day:k, orders:0, revenue:0, fromCust:0, fromWorker:0, online:0, cash:0, done:0, jobs:[] });
      const cf = b.platformFee ?? 0, wf = b.workerDeduction ?? 0;
      d.orders++; d.revenue += b.total || 0; d.fromCust += cf; d.fromWorker += wf;
      if (b.paymentMethod === "cash") d.cash += cf + wf; else d.online += cf + wf;
      if (["completed","paid"].includes(b.status)) d.done++;
      d.jobs.push(b);
    });
    return m;
  }, [valid]);
  const all = Object.values(days);
  const latest = all.length ? all.map(d => d.day).sort().pop() : null;
  const base = latest ? new Date(latest + "T00:00:00") : new Date();
  const [month, setMonth] = useState({ y: base.getFullYear(), m: base.getMonth() });
  const [open, setOpen] = useState(null);
  const [selDay, setSelDay] = useState(null);
  const pad = n => String(n).padStart(2, "0");
  const prefix = `${month.y}-${pad(month.m + 1)}`;
  const mDays = all.filter(d => d.day.startsWith(prefix)).sort((a, b) => b.day.localeCompare(a.day));
  const val = d => isEarn ? d.fromCust + d.fromWorker : d.revenue;
  const sum = (arr, f) => arr.reduce((s, d) => s + f(d), 0);
  const monthTotal = sum(mDays, val), allTotal = sum(all, val);
  const monthOrders = sum(mDays, d => d.orders), allOrders = sum(all, d => d.orders);
  const best = mDays.reduce((a, d) => (!a || val(d) > val(a) ? d : a), null);
  const mName = new Date(month.y, month.m, 1).toLocaleDateString("en-IN", { month:"long", year:"numeric" });
  const accent = isEarn ? C.green : C.amber;
  const card = { background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"14px 16px", marginBottom:12 };
  const row = (l, v, col) => <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, padding:"4px 0" }}><span style={{ color:C.muted }}>{l}</span><b style={{ color:col || C.text }}>{v}</b></div>;
  const [exporting, setExporting] = useState(false);
  async function doExport(list, label) {
    if (!list.length) return;
    setExporting(true);
    try {
      const head = ["Date","Booking ID","Customer","Worker","Service","Status","Payment","Service charge (Rs)","Platform charge from customer (Rs)","Deduction from worker (Rs)","Platform earned (Rs)","Customer paid (Rs)"];
      const body = [];
      [...list].sort((a, b) => a.day.localeCompare(b.day)).forEach(d => d.jobs.forEach(j => {
        const cf = j.platformFee ?? 0, wf = j.workerDeduction ?? 0;
        body.push([d.day, String(j._id).slice(-6), j.customerName || "", j.workerName || "", j.serviceType || "", j.status, j.paymentMethod || "", j.jobTotal ?? "", cf, wf, cf + wf, j.total ?? ""]);
      }));
      const t = c => body.reduce((a, r) => a + (Number(r[c]) || 0), 0);
      body.push(["TOTAL","","","","","","", t(7), t(8), t(9), t(10), t(11)]);
      await exportCsv(`ProWorkers_${label}_${isEarn ? "earnings" : "revenue"}.csv`, [head, ...body]);
    } catch (e) { window.alert("Could not export: " + (e?.message || e)); }
    setExporting(false);
  }
  const mCust = sum(mDays, d => d.fromCust), mWork = sum(mDays, d => d.fromWorker);
  const aCust = sum(all, d => d.fromCust), aWork = sum(all, d => d.fromWorker);
  const aOnline = sum(all, d => d.online), aCash = sum(all, d => d.cash);

  return (
    <div style={{ position:"fixed", inset:0, zIndex:300, background:C.bg, color:C.text, overflowY:"auto", fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={{ position:"sticky", top:0, background:C.card, borderBottom:`1px solid ${C.border}`, padding:"12px 16px", display:"flex", alignItems:"center", gap:12, zIndex:2 }}>
        <button onClick={onClose} style={{ background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:10, padding:"6px 12px", cursor:"pointer", fontWeight:700, fontSize:13 }}>← Back</button>
        <div style={{ fontWeight:800, fontSize:15 }}>{isEarn ? "🏦 Platform earnings, day by day" : "💰 Platform revenue, day by day"}</div>
      </div>
      <div style={{ maxWidth:760, margin:"0 auto", padding:"16px 16px 60px" }}>
        <div style={{ ...card, background:`linear-gradient(135deg, ${accent}22, ${accent}08)`, border:`1px solid ${accent}44` }}>
          <div style={{ fontSize:12, fontWeight:700, color:accent }}>{isEarn ? "TOTAL KEPT BY PLATFORM (ALL TIME)" : "TOTAL BILLED TO CUSTOMERS (ALL TIME)"}</div>
          <div style={{ fontSize:32, fontWeight:900 }}>{rupee(allTotal)}</div>
          <div style={{ fontSize:12, color:C.muted }}>{allOrders} orders · avg {rupee(allOrders ? allTotal / allOrders : 0)} per order</div>
        </div>

        {isEarn && (
          <div style={card}>
            <div style={{ fontWeight:800, fontSize:13, marginBottom:6 }}>Where it comes from (all time)</div>
            {row("From customers (₹0 / ₹10 / ₹20 by order value)", rupee(aCust), C.blue)}
            {row("From workers (₹10 online / ₹15 cash)", rupee(aWork), C.amber)}
            {row("Total", rupee(aCust + aWork), C.green)}
            <div style={{ height:1, background:C.border, margin:"8px 0" }}/>
            {row("Already with platform (online payments)", rupee(aOnline), C.green)}
            {row("To recover from workers (cash jobs)", rupee(aCash), C.red)}
            <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>Cash jobs: the worker keeps the customer's cash and has to pay you the platform fee. It is cut from their online earnings.</div>
          </div>
        )}

        <MonthCalendar C={C} month={month} onMonth={m => { setSelDay(null); setOpen(null); setMonth(m); }}
          info={Object.fromEntries(all.map(d => [d.day, { top: `${d.orders} order${d.orders === 1 ? "" : "s"}`, sub: rupee(val(d)) }]))}
          selected={selDay} onPick={k => { setSelDay(k); setOpen(k); }}
          hint={isEarn ? "Green days have orders. Tap a day to see where its earnings came from." : "Green days have orders. Tap a day to see its orders."}/>

        <div style={card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end" }}>
            <div>
              <div style={{ fontSize:11, color:C.muted }}>This month</div>
              <div style={{ fontSize:24, fontWeight:900, color:accent }}>{rupee(monthTotal)}</div>
              <div style={{ fontSize:11, color:C.muted }}>{monthOrders} orders{mDays.length ? ` · avg ${rupee(monthTotal / mDays.length)}/day` : ""}</div>
            </div>
            {best && <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:11, color:C.muted }}>Best day</div>
              <div style={{ fontSize:14, fontWeight:800 }}>{rupee(val(best))}</div>
              <div style={{ fontSize:11, color:C.muted }}>{dayLabel(best.day).replace(/, \d{4}$/, "")}</div>
            </div>}
          </div>
          {isEarn && mDays.length > 0 && <div style={{ marginTop:8 }}>{row("From customers", rupee(mCust), C.blue)}{row("From workers", rupee(mWork), C.amber)}</div>}
        </div>

        <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap" }}>
          <button disabled={exporting || !mDays.length} onClick={() => doExport(mDays, prefix)} style={{ flex:1, minWidth:150, background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:10, padding:"10px 12px", fontWeight:800, fontSize:12, cursor:"pointer", opacity: mDays.length ? 1 : 0.5 }}>📥 Export {mName} (Excel)</button>
          {selDay && days[selDay] && <button disabled={exporting} onClick={() => doExport([days[selDay]], selDay)} style={{ flex:1, minWidth:150, background:C.amber, border:"none", color:"#000", borderRadius:10, padding:"10px 12px", fontWeight:800, fontSize:12, cursor:"pointer" }}>📥 Export {dayLabel(selDay).replace(/, \d{4}$/, "")}</button>}
        </div>
        {selDay && <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", margin:"4px 2px 8px" }}><b style={{ fontSize:14 }}>{dayLabel(selDay)}</b><button onClick={() => setSelDay(null)} style={{ background:"none", border:"none", color:C.amber, cursor:"pointer", fontSize:12, fontWeight:700 }}>Show month</button></div>}
        {(selDay ? !days[selDay] : mDays.length === 0) && <div style={{ textAlign:"center", color:C.muted, padding:"30px 0", fontSize:13 }}>{selDay ? "No orders on this day." : `No orders in ${mName}.`}</div>}
        {(selDay ? mDays.filter(d => d.day === selDay) : mDays).map(d => (
          <div key={d.day} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, marginBottom:8, overflow:"hidden" }}>
            <div onClick={() => setOpen(open === d.day ? null : d.day)} style={{ padding:"12px 14px", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontWeight:800, fontSize:13 }}>{dayLabel(d.day)}</div>
                <div style={{ fontSize:11, color:C.muted }}>{d.orders} orders · {d.done} done{isEarn ? ` · customers ${rupee(d.fromCust)} + workers ${rupee(d.fromWorker)}` : ` · fees ${rupee(d.fromCust + d.fromWorker)}`}</div>
              </div>
              <div style={{ fontWeight:900, fontSize:15, color:accent }}>{rupee(val(d))} <span style={{ color:C.muted, fontSize:11 }}>{open === d.day ? "▲" : "▼"}</span></div>
            </div>
            {open === d.day && (
              <div style={{ borderTop:`1px solid ${C.border}`, padding:"6px 14px 10px" }}>
                {d.jobs.map(j => (
                  <div key={j._id} style={{ display:"flex", justifyContent:"space-between", fontSize:12, padding:"6px 0", borderBottom:`1px dashed ${C.border}` }}>
                    <span>{j.customerName || "Customer"} → {j.workerName || "Unassigned"} <span style={{ color:C.muted }}>· {j.serviceType}{j.paymentMethod ? ` · ${j.paymentMethod}` : ""}</span></span>
                    <b style={{ color:accent }}>{isEarn ? `${rupee((j.platformFee ?? 0) + (j.workerDeduction ?? 0))}` : rupee(j.total)}</b>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        <div style={{ fontSize:11, color:C.muted, marginTop:10 }}>Counts all non-cancelled orders by the day they were booked (India time), same as the figures on the Overview.</div>
      </div>
    </div>
  );
}

function AdminApp({ user, onLogout, C, toast, setToast }) {
  const [tab, setTab] = useState("overview");
  usePushOpen(d => setTab(({ payment:"payments", withdrawal:"withdrawals", complaint:"complaints" })[d.type] || "overview"));
  const [selWorker, setSelWorker] = useState(null);
  const [revView, setRevView] = useState(null);   // "revenue" | "earnings"
  const [dayFilter, setDayFilter] = useState(""); // YYYY-MM-DD, "" = all days
  const [stats, setStats] = useState(null);
  const [workers, setWorkers] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [complaints, setComplaints] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState("");
  const [complaintFilter, setComplaintFilter] = useState("all");
  const [withdrawals, setWithdrawals] = useState([]);
  const [payFilter, setPayFilter] = useState("pending_verification");
  const [wdFilter,  setWdFilter]  = useState("requested");
  const [upiId,     setUpiId]     = useState("");
  const [upiInput,  setUpiInput]  = useState("");
  const prevCounts = useRef(null);
  const token = localStorage.getItem("pt_token");

  const fmt = n => typeof n === "number" ? `₹${n.toLocaleString("en-IN", { maximumFractionDigits:0 })}` : "₹0";
  const todayIST = istDayOf(new Date());
  const activeDay = dayFilter || todayIST;   // the calendar day shown in Bookings / Payments / Payouts

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const [s, w, b, c, cu, wd] = await Promise.all([
        API("/admin/stats"),
        API("/admin/workers"),
        API("/admin/bookings"),
        API("/admin/complaints"),
        API("/admin/customers"),
        API("/admin/withdrawals", { token }),
      ]);
      if (s.error) throw new Error(s.error);
      setWithdrawals(wd.withdrawals || []);
      setStats(s);
      setWorkers(w.workers || []);
      setBookings(b.bookings || []);
      setComplaints(c.complaints || []);
      setCustomers(cu.customers || []);
    } catch(e) {
      console.error(e);
      setLoadError(e.message || "Failed to load. Is the backend running on port 5000?");
    }
    setLoading(false);
  }

  // Load on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  // Light refresh (no loading spinner) for payments + payouts
  async function refreshLists() {
    try {
      const [b, wd] = await Promise.all([API("/admin/bookings"), API("/admin/withdrawals", { token })]);
      if (b.bookings) setBookings(b.bookings);
      if (wd.withdrawals) setWithdrawals(wd.withdrawals);
    } catch {}
  }
  useEffect(() => {
    const t = setInterval(refreshLists, 10000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiGet("/settings").then(d => { setUpiId(d.upiId || ""); setUpiInput(d.upiId || ""); }).catch(() => {});
  }, []);
  async function saveUpi() {
    const id = upiInput.trim();
    // Step 1: email a confirmation code to the admin address
    const q = await API("/admin/settings/upi/request", { method:"POST", token, body: JSON.stringify({ upiId: id }) });
    if (q.error) { setToast({ msg:"⚠️ " + q.error, color:C.red }); return; }
    // Step 2: enter the code
    const code = window.prompt(`We emailed a 6-digit code to ${q.maskedEmail}. Enter it to change the UPI ID:`, "");
    if (!code) { setToast({ msg:"UPI change cancelled.", color:C.amber }); return; }
    const r = await API("/admin/settings/upi", { method:"PUT", token, body: JSON.stringify({ upiId: id, code: code.trim() }) });
    if (r.error) { setToast({ msg:"⚠️ " + r.error, color:C.red }); return; }
    setUpiId(r.upiId); setUpiInput(r.upiId);
    setToast({ msg:"✅ UPI ID updated. New payments go to " + r.upiId, color:C.green });
  }

  const pendingPayments    = bookings.filter(b => b.paymentStatus === "pending_verification");
  const pendingWithdrawals = withdrawals.filter(w => w.status === "requested");

  // Alert the admin when something NEW needs action (toast + browser notification)
  useEffect(() => {
    if (loading) return;
    const cur  = { p: pendingPayments.length, w: pendingWithdrawals.length };
    const prev = prevCounts.current;
    if (prev) {
      if (cur.p > prev.p) {
        setToast({ msg:`💳 New payment to verify (${cur.p} pending)`, color:C.amber });
        pushNotif("Payment to verify", `${cur.p} payment(s) waiting for verification.`);
      } else if (cur.w > prev.w) {
        setToast({ msg:`💸 New withdrawal request (${cur.w} pending)`, color:C.amber });
        pushNotif("Withdrawal requested", `${cur.w} withdrawal request(s) waiting.`);
      }
    }
    prevCounts.current = cur;
  }, [pendingPayments.length, pendingWithdrawals.length, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  async function reviewPayment(id, action) {
    let note;
    if (action === "reject") {
      note = window.prompt("Reason for rejecting (shown to the customer):", "Payment not found in my UPI history.");
      if (note === null) return;
    } else if (!window.confirm("Verify this payment? Only do this if you can see it in your UPI / bank history.")) return;
    const r = await API(`/admin/bookings/${id}/payment`, { method:"PATCH", token, body: JSON.stringify({ action, note }) });
    if (r.error) setToast({ msg:"⚠️ " + r.error, color:C.red });
    else setToast({ msg: action === "verify" ? "✅ Payment verified." : "Payment rejected.", color: action === "verify" ? C.green : C.amber });
    refreshLists();
  }

  async function reviewWithdrawal(id, action) {
    let payoutUtr, note;
    if (action === "paid") {
      payoutUtr = window.prompt("Payout UTR (optional). Enter it after you've paid the worker:", "");
      if (payoutUtr === null) return;
    } else {
      note = window.prompt("Reason for rejecting (shown to the worker):", "");
      if (note === null) return;
    }
    const r = await API(`/admin/withdrawals/${id}`, { method:"PATCH", token, body: JSON.stringify({ action, payoutUtr, note }) });
    if (r.error) setToast({ msg:"⚠️ " + r.error, color:C.red });
    else setToast({ msg: action === "paid" ? "✅ Marked as paid." : "Withdrawal rejected.", color: action === "paid" ? C.green : C.amber });
    refreshLists();
  }

  async function deleteWorker(id) {
    if (!window.confirm("Delete this worker permanently?")) return;
    await API(`/admin/workers/${id}`, { method:"DELETE" });
    setToast({ msg:"Worker removed.", color:C.red });
    load();
  }

  async function updateComplaint(id, status, note) {
    await API(`/admin/complaints/${id}`, { method:"PUT", body: JSON.stringify({ status, adminNote: note }) });
    setToast({ msg:"Complaint updated.", color:C.green });
    load();
  }

  const TABS = [
    { id:"overview",   icon:"📊", label:"Overview" },
    { id:"bookings",   icon:"📋", label:"Bookings" },
    { id:"workers",    icon:"👷", label:"Workers" },
    { id:"customers",  icon:"👥", label:"Customers" },
    { id:"complaints", icon:"🚨", label:"Complaints" },
    { id:"payments",    icon:"💳", label:"Payments", badge: pendingPayments.length },
    { id:"withdrawals", icon:"💸", label:"Payouts",  badge: pendingWithdrawals.length },
  ];

  const statusColor = s => ({ pending_acceptance:C.amber, assigned:C.amber, on_way:C.blue, in_progress:C.blue, completed:C.green, cancelled:C.red, paid:C.green }[s] || C.muted);
  const statusLabel = s => ({ pending_acceptance:"🔍 Finding Worker", assigned:"✅ Worker Assigned", on_way:"🚗 On the Way", in_progress:"🔧 In Progress", completed:"✅ Completed", cancelled:"❌ Cancelled", paid:"💚 Paid" }[s] || s?.toUpperCase());
  const svcIcon = s => ({ electrician:"⚡", plumber:"🔧", labour:"👷" }[s] || "🛠️");

  const filteredBookings = bookings.filter(b =>
    !search || b.customerName?.toLowerCase().includes(search.toLowerCase()) ||
    b.workerName?.toLowerCase().includes(search.toLowerCase()) ||
    b.serviceType?.toLowerCase().includes(search.toLowerCase())
  );

  const filteredWorkers = workers.filter(w =>
    !search || w.name?.toLowerCase().includes(search.toLowerCase()) ||
    w.email?.toLowerCase().includes(search.toLowerCase()) ||
    w.workerType?.toLowerCase().includes(search.toLowerCase())
  );

  const filteredCustomers = customers.filter(c =>
    !search || c.name?.toLowerCase().includes(search.toLowerCase()) ||
    c.email?.toLowerCase().includes(search.toLowerCase())
  );

  const filteredComplaints = complaints.filter(c =>
    (complaintFilter === "all" || c.status === complaintFilter) &&
    (!search || c.customerName?.toLowerCase().includes(search.toLowerCase()) || c.workerName?.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div style={{ minHeight:"100vh", background:C.bg, fontFamily:"'Inter',system-ui,sans-serif", color:C.text, paddingBottom:72 }}>
      {revView && <RevenueDetail mode={revView} bookings={bookings} C={C} onClose={() => setRevView(null)}/>}
      {selWorker && <WorkerDetail workerId={selWorker} C={C} onClose={() => setSelWorker(null)}/>}
      {/* Header */}
      <div style={{ background:C.card, borderBottom:`1px solid ${C.border}`, padding:"13px 20px", position:"sticky", top:0, zIndex:50, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ display:"flex", alignItems:"center", gap:8, fontSize:22, fontWeight:900, color:C.amber, letterSpacing:-1 }}>
            <img src="/logo.jpg" alt="ProWorkers" style={{ height:32, width:"auto", borderRadius:6, objectFit:"contain" }}/>
            ProWorkers
          </span>
          <span style={{ background:C.amber+"22", color:C.amber, fontSize:10, fontWeight:800, padding:"2px 8px", borderRadius:20 }}>ADMIN</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <button onClick={load} style={{ background:"none", border:`1px solid ${C.border}`, color:C.muted, borderRadius:8, padding:"5px 10px", cursor:"pointer", fontSize:12 }}>🔄 Refresh</button>
          <button onClick={onLogout} style={{ background:C.red+"22", border:"none", color:C.red, borderRadius:8, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:700 }}>Logout</button>
        </div>
      </div>

      {loading && <div style={{ textAlign:"center", padding:40, color:C.muted }}>Loading dashboard…</div>}

      {!loading && loadError && (
        <div style={{ margin:20, background:C.red+"22", border:`1px solid ${C.red}`, borderRadius:12, padding:"16px 18px" }}>
          <div style={{ color:C.red, fontWeight:800, fontSize:14, marginBottom:6 }}>❌ Could not load dashboard</div>
          <div style={{ color:C.text, fontSize:13, marginBottom:12 }}>{loadError}</div>
          <div style={{ color:C.muted, fontSize:12, marginBottom:12 }}>Make sure your backend is running: <code style={{ background:C.card2, padding:"2px 6px", borderRadius:4 }}>node server.js</code> in the <b>backend</b> folder</div>
          <button onClick={load} style={{ background:C.amber, border:"none", color:"#000", borderRadius:8, padding:"8px 18px", fontWeight:800, fontSize:13, cursor:"pointer" }}>🔄 Try Again</button>
        </div>
      )}

      {!loading && !loadError && (
        <div style={{ padding:"16px 14px" }}>
          {/* Search bar (show on non-overview tabs) */}
          {tab !== "overview" && (
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder={`Search ${tab}…`}
              style={{ width:"100%", padding:"10px 14px", background:C.card2, border:`1px solid ${C.border}`, borderRadius:10, color:C.text, fontSize:14, outline:"none", boxSizing:"border-box", marginBottom:14 }}
            />
          )}

          {/* ── OVERVIEW ─────────────────────────────────── */}
          {tab === "overview" && stats && (
            <div>
              {/* Needs attention: everything that waits for the admin, in one place */}
              {(() => {
                const waitingOrders = bookings.filter(b => b.status === "pending_acceptance" && Date.now() - new Date(b.createdAt).getTime() > 10 * 60 * 1000);
                const openComplaints = complaints.filter(c => c.status === "open");
                const items = [
                  { n: pendingPayments.length,    icon:"💳", text:"payments to verify",          go: () => { setPayFilter("pending_verification"); setDayFilter(""); setTab("payments"); } },
                  { n: pendingWithdrawals.length, icon:"💸", text:"payout requests to pay",      go: () => { setWdFilter("requested"); setDayFilter(""); setTab("withdrawals"); } },
                  { n: openComplaints.length,     icon:"🚨", text:"open complaints",             go: () => { setComplaintFilter("open"); setTab("complaints"); } },
                  { n: waitingOrders.length,      icon:"⏱️", text:"orders waiting over 10 min for a worker", go: () => { setDayFilter(""); setTab("bookings"); } },
                ].filter(x => x.n > 0);
                return (
                  <div style={{ background: items.length ? C.red + "12" : C.green + "12", border:`1px solid ${items.length ? C.red + "55" : C.green + "55"}`, borderRadius:14, padding:"14px 16px", marginBottom:16 }}>
                    <div style={{ fontWeight:800, fontSize:13, marginBottom: items.length ? 8 : 0, color: items.length ? C.red : C.green }}>{items.length ? "⚠️ NEEDS YOUR ATTENTION" : "✅ All clear. Nothing is waiting for you."}</div>
                    {items.map(x => (
                      <div key={x.text} onClick={x.go} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 0", borderTop:`1px solid ${C.border}`, cursor:"pointer" }}>
                        <span style={{ fontSize:13 }}>{x.icon} <b style={{ color:C.amber }}>{x.n}</b> {x.text}</span>
                        <span style={{ color:C.muted, fontSize:16 }}>›</span>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Revenue banner */}
              <div onClick={() => setRevView("revenue")} style={{ cursor:"pointer", background:`linear-gradient(135deg, ${C.amber}22, ${C.amber}08)`, border:`1px solid ${C.amber}44`, borderRadius:16, padding:"20px 18px", marginBottom:16 }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.amber, marginBottom:4, display:"flex", justifyContent:"space-between" }}><span>💰 TOTAL PLATFORM REVENUE</span><span>Day by day ›</span></div>
                <div style={{ fontSize:34, fontWeight:900, color:C.text }}>{fmt(stats.totalRevenue)}</div>
                <div style={{ display:"flex", gap:20, marginTop:8 }}>
                  <div>
                    <div style={{ fontSize:11, color:C.muted }}>This Month</div>
                    <div style={{ fontSize:16, fontWeight:800, color:C.amber }}>{fmt(stats.monthRevenue)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize:11, color:C.muted }}>Last Month</div>
                    <div style={{ fontSize:16, fontWeight:800, color:C.sub }}>{fmt(stats.lastMonthRevenue)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize:11, color:C.muted }}>Platform charges</div>
                    <div style={{ fontSize:16, fontWeight:800, color:C.green }}>{fmt(stats.platformEarnings)}</div>
                  </div>
                </div>
              </div>

              {/* Key stats grid */}
              <div style={{ display:"flex", flexWrap:"wrap", gap:10, marginBottom:16 }}>
                <StatCard icon="📦" label="Total Orders" value={stats.totalBookings} sub={`${stats.todayBookings} today · ${stats.monthBookings} this month`} color={C.blue} C={C}/>
                <StatCard icon="👷" label="Workers" value={stats.totalWorkers} sub="On platform" color={C.amber} C={C}/>
                <StatCard icon="👥" label="Customers" value={stats.totalCustomers} sub="Registered" color={C.green} C={C}/>
                <StatCard icon="🚨" label="Complaints" value={stats.totalComplaints} sub={`${stats.openComplaints} open`} color={stats.openComplaints > 0 ? C.red : C.muted} C={C}/>
              </div>

              {/* Booking status breakdown */}
              <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"16px 18px", marginBottom:14 }}>
                <div style={{ fontWeight:800, fontSize:14, marginBottom:12 }}>📦 Order Status Breakdown</div>
                {[
                  { label:"✅ Completed", val: stats.completedBookings, color: C.green },
                  { label:"🔄 Active",    val: stats.activeBookings,   color: C.blue },
                  { label:"❌ Cancelled", val: stats.cancelledBookings, color: C.red },
                ].map(s => (
                  <div key={s.label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                    <span style={{ fontSize:13, color:C.text }}>{s.label}</span>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <div style={{ width:80, height:6, background:C.border, borderRadius:4, overflow:"hidden" }}>
                        <div style={{ height:"100%", width:`${stats.totalBookings ? (s.val/stats.totalBookings)*100 : 0}%`, background:s.color, borderRadius:4 }}/>
                      </div>
                      <span style={{ fontSize:13, fontWeight:800, color:s.color, width:28, textAlign:"right" }}>{s.val}</span>
                    </div>
                  </div>
                ))}
                <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>Completion rate: <b style={{ color:C.green }}>{stats.completionRate}%</b></div>
              </div>

              {/* Last 7 days mini chart */}
              <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"16px 18px", marginBottom:14 }}>
                <div style={{ fontWeight:800, fontSize:14, marginBottom:12 }}>📈 Orders — Last 7 Days</div>
                <MiniBar data={stats.last7Days} C={C}/>
                <div style={{ display:"flex", justifyContent:"space-between", marginTop:8 }}>
                  {(stats.last7Days||[]).map(d => (
                    <div key={d.date} style={{ flex:1, textAlign:"center" }}>
                      <div style={{ fontSize:10, color:C.text, fontWeight:700 }}>{d.bookings}</div>
                      <div style={{ fontSize:9, color:C.muted }}>{fmt(d.revenue).replace("₹","")}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Services breakdown */}
              <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"16px 18px", marginBottom:14 }}>
                <div style={{ fontWeight:800, fontSize:14, marginBottom:12 }}>🛠️ Orders by Service</div>
                {(stats.bookingsByService||[]).map(s => (
                  <div key={s._id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                    <span style={{ fontSize:13 }}>{svcIcon(s._id)} {s._id || "Unknown"}</span>
                    <div style={{ display:"flex", gap:14 }}>
                      <span style={{ fontSize:12, color:C.muted }}>{s.count} orders</span>
                      <span style={{ fontSize:12, fontWeight:700, color:C.amber }}>{fmt(s.revenue)}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Top workers */}
              {(stats.topWorkers||[]).length > 0 && (
                <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"16px 18px", marginBottom:14 }}>
                  <div style={{ fontWeight:800, fontSize:14, marginBottom:12 }}>🏆 Top Workers</div>
                  {stats.topWorkers.map((w, i) => (
                    <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8, padding:"8px 0", borderBottom: i < stats.topWorkers.length-1 ? `1px solid ${C.border}` : "none" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ width:22, height:22, borderRadius:"50%", background:C.amber+"22", color:C.amber, fontWeight:800, fontSize:11, display:"flex", alignItems:"center", justifyContent:"center" }}>{i+1}</span>
                        <div>
                          <div style={{ fontSize:13, fontWeight:700 }}>{w._id}</div>
                          <div style={{ fontSize:11, color:C.muted }}>{w.jobs} jobs · ⭐ {w.avgRating ? w.avgRating.toFixed(1) : "–"}</div>
                        </div>
                      </div>
                      <span style={{ fontSize:13, fontWeight:800, color:C.green }}>{fmt(w.revenue)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Platform earnings card */}
              <div onClick={() => setRevView("earnings")} style={{ cursor:"pointer", background:`linear-gradient(135deg, ${C.green}22, ${C.green}08)`, border:`1px solid ${C.green}44`, borderRadius:14, padding:"16px 18px" }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.green, marginBottom:4, display:"flex", justifyContent:"space-between" }}><span>🏦 PLATFORM EARNINGS (CHARGES)</span><span>Day by day ›</span></div>
                <div style={{ fontSize:28, fontWeight:900, color:C.text }}>{fmt(stats.platformEarnings)}</div>
                <div style={{ fontSize:12, color:C.muted, marginTop:4 }}>This month: <b style={{ color:C.green }}>{fmt(stats.platformEarningsMonth)}</b></div>
              </div>
            </div>
          )}

          {/* ── BOOKINGS ─────────────────────────────────── */}
          {tab === "bookings" && (() => {
            const rowsAll = filteredBookings.filter(b => search || istDayOf(b.createdAt) === activeDay);
            const groups = groupByDay(rowsAll, b => b.createdAt);
            return (
            <div>
              <DayFilter C={C} value={dayFilter} onChange={setDayFilter} info={dayInfoMap(bookings.filter(b => b.status !== "cancelled"), b => b.createdAt, "order", b => b.total)}/>
              <div style={{ fontSize:12, color:C.muted, marginBottom:4 }}>{search ? `Search results from all days: ${rowsAll.length}` : `${rowsAll.length} orders on this day`}</div>
              {groups.length === 0 && <div style={{ textAlign:"center", color:C.muted, padding:"30px 0", fontSize:13 }}>No orders on this day.</div>}
              {groups.map(g => (
                <div key={g.day}>
                  <DayHeader C={C} day={g.day} left={`${g.rows.length} orders`} right={fmt(g.rows.filter(b => b.status !== "cancelled").reduce((t, b) => t + (b.total || 0), 0))}/>
                  {g.rows.map(b => (
                <div key={b._id} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 14px", marginBottom:10 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                    <div>
                      <div style={{ fontWeight:800, fontSize:14 }}>{svcIcon(b.serviceType)} {b.customerName || "Customer"}</div>
                      <div style={{ fontSize:12, color:C.muted }}>→ {b.workerName || "Unassigned"} · {b.serviceType}</div>
                      {b.address && <div style={{ fontSize:12, color:C.muted, marginTop:3 }}>📍 {b.address} · <a href={navLink(b)} target="_blank" rel="noopener noreferrer" style={{ color:C.blue, fontWeight:700, textDecoration:"none" }}>Open map ↗</a></div>}
                    </div>
                    <span style={{ background:statusColor(b.status)+"22", color:statusColor(b.status), fontSize:10, fontWeight:800, padding:"3px 8px", borderRadius:20 }}>{statusLabel(b.status)}</span>
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", marginTop:8, paddingTop:8, borderTop:`1px solid ${C.border}` }}>
                    <span style={{ fontSize:12, color:C.muted }}>{b.date} {b.time}</span>
                    <span style={{ fontSize:14, fontWeight:800, color:C.amber }}>{fmt(b.total)}</span>
                  </div>
                </div>
                  ))}
                </div>
              ))}
            </div>
            );
          })()}

          {/* ── WORKERS ──────────────────────────────────── */}
          {tab === "workers" && (
            <div>
              <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>Showing {filteredWorkers.length} of {workers.length} workers</div>
              {filteredWorkers.map(w => (
                <div key={w._id} onClick={() => setSelWorker(w._id)} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 14px", marginBottom:10, cursor:"pointer" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div>
                      <div style={{ fontWeight:800, fontSize:14 }}>{svcIcon(w.workerType)} {w.name} <span style={{ color:C.muted, fontWeight:600, fontSize:11 }}>· tap for details ›</span></div>
                      <div style={{ fontSize:12, color:C.muted }}>{w.email} · {w.phone}</div>
                      <div style={{ fontSize:11, marginTop:4 }}>
                        <span style={{ background:C.amber+"22", color:C.amber, padding:"2px 8px", borderRadius:10, fontSize:11, fontWeight:700 }}>{w.workerType}</span>
                        <span style={{ color:C.muted, marginLeft:8 }}>📍 {w.area || w.location || "—"}</span>
                        <span style={{ color: w.isOnline ? C.green : C.muted, marginLeft:8 }}>{w.isOnline ? "🟢 Online" : "⚫ Offline"}</span>
                      </div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); deleteWorker(w._id); }} style={{ background:C.red+"22", border:"none", color:C.red, borderRadius:8, padding:"6px 10px", cursor:"pointer", fontSize:12, fontWeight:700 }}>Remove</button>
                  </div>
                  <div style={{ display:"flex", gap:16, marginTop:10, paddingTop:8, borderTop:`1px solid ${C.border}` }}>
                    <div style={{ fontSize:12 }}><span style={{ color:C.muted }}>Joined: </span>{new Date(w.createdAt).toLocaleDateString("en-IN")}</div>
                    <div style={{ fontSize:12 }}><span style={{ color:C.muted }}>Trust: </span><b style={{ color:C.amber }}>{w.trust}%</b></div>
                    <div style={{ fontSize:12 }}><span style={{ color:C.muted }}>Rating: </span><b style={{ color:C.amber }}>⭐ {w.rating||"—"}</b></div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── CUSTOMERS ────────────────────────────────── */}
          {tab === "customers" && (
            <div>
              <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>Showing {filteredCustomers.length} of {customers.length} customers</div>
              {filteredCustomers.map(c => (
                <div key={c._id} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 14px", marginBottom:10 }}>
                  <div style={{ fontWeight:800, fontSize:14 }}>👤 {c.name}</div>
                  <div style={{ fontSize:12, color:C.muted }}>{c.email} · {c.phone}</div>
                  <div style={{ display:"flex", gap:16, marginTop:8, paddingTop:8, borderTop:`1px solid ${C.border}` }}>
                    <div style={{ fontSize:12 }}><span style={{ color:C.muted }}>Area: </span>{c.area || c.location || "—"}</div>
                    <div style={{ fontSize:12 }}><span style={{ color:C.muted }}>Bookings: </span><b style={{ color:C.blue }}>{c.bookingCount||0}</b></div>
                    <div style={{ fontSize:12 }}><span style={{ color:C.muted }}>Joined: </span>{new Date(c.createdAt).toLocaleDateString("en-IN")}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── COMPLAINTS ───────────────────────────────── */}
          {tab === "complaints" && (
            <div>
              <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
                {["all","open","reviewing","resolved","closed"].map(f => (
                  <button key={f} onClick={() => setComplaintFilter(f)} style={{ background: complaintFilter===f ? C.amber : C.card2, border:`1px solid ${complaintFilter===f ? C.amber : C.border}`, color: complaintFilter===f ? "#000" : C.muted, borderRadius:20, padding:"4px 12px", fontSize:11, fontWeight:700, cursor:"pointer" }}>
                    {f.charAt(0).toUpperCase()+f.slice(1)}
                  </button>
                ))}
              </div>
              <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>Showing {filteredComplaints.length} complaints</div>
              {filteredComplaints.map(c => (
                <ComplaintAdminCard key={c._id} complaint={c} onUpdate={updateComplaint} C={C}/>
              ))}
            </div>
          )}

          {/* ── PAYMENTS (manual UPI verification) ───────── */}
          {tab === "payments" && (() => {
            const q = search.toLowerCase();
            const rows = bookings
              .filter(b => b.paymentStatus && b.paymentStatus !== "none")
              .filter(b => payFilter === "all" || b.paymentStatus === payFilter)
              .filter(b => !q || b.customerName?.toLowerCase().includes(q) || b.utr?.includes(q) || b.workerName?.toLowerCase().includes(q))
              .filter(b => q || istDayOf(b.paymentSubmittedAt) === activeDay)
              .sort((a, b) => new Date(b.paymentSubmittedAt || 0) - new Date(a.paymentSubmittedAt || 0));
            const payPendOther = bookings.filter(b => b.paymentStatus === "pending_verification" && istDayOf(b.paymentSubmittedAt) !== activeDay).map(b => istDayOf(b.paymentSubmittedAt)).sort();
            const payDayTotals = {};
            rows.forEach(b => { const k = istDayOf(b.paymentSubmittedAt); const t = payDayTotals[k] || (payDayTotals[k] = { n:0, all:0, ok:0 }); t.n++; t.all += b.total || 0; if (b.paymentStatus === "verified") t.ok += b.total || 0; });
            const pc = { pending_verification:C.amber, verified:C.green, rejected:C.red };
            const pl = { pending_verification:"⏳ PENDING", verified:"✅ VERIFIED", rejected:"❌ REJECTED" };
            return (
              <div>
                <AutoVerifyCard C={C} token={token}/>
                <div style={{ background:C.card, border:`1px solid ${upiId ? C.border : C.red}`, borderRadius:12, padding:14, marginBottom:14 }}>
                  <div style={{ fontWeight:800, fontSize:13, marginBottom:4 }}>📱 Receiving UPI ID</div>
                  <div style={{ fontSize:11, color:C.muted, marginBottom:8 }}>{upiId ? `Customers currently pay to: ${upiId}` : "Not set yet. Customers can't pay by UPI until you add it."}</div>
                  <div style={{ display:"flex", gap:8 }}>
                    <input value={upiInput} onChange={e => setUpiInput(e.target.value)} placeholder="yourname@bank" autoCapitalize="none" style={{ flex:1, minWidth:0, padding:"9px 12px", background:C.card2, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, fontSize:13, outline:"none" }}/>
                    <button onClick={saveUpi} disabled={!upiInput.trim() || upiInput.trim() === upiId} style={{ background:C.amber, border:"none", color:"#000", borderRadius:8, padding:"9px 16px", fontWeight:800, fontSize:12, cursor:"pointer", opacity:(!upiInput.trim() || upiInput.trim() === upiId) ? 0.5 : 1 }}>Save</button>
                  </div>
                </div>
                <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
                  {[["pending_verification","Pending"],["verified","Verified"],["rejected","Rejected"],["all","All"]].map(([f,l]) => (
                    <button key={f} onClick={() => setPayFilter(f)} style={{ background: payFilter===f ? C.amber : C.card2, border:`1px solid ${payFilter===f ? C.amber : C.border}`, color: payFilter===f ? "#000" : C.muted, borderRadius:20, padding:"4px 12px", fontSize:11, fontWeight:700, cursor:"pointer" }}>{l}</button>
                  ))}
                </div>
                <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>Check each UTR in your UPI app / bank history before verifying.</div>
                {rows.length === 0 && <div style={{ textAlign:"center", color:C.muted, padding:"30px 0", fontSize:13 }}>No payments here.</div>}
                <DayFilter C={C} value={dayFilter} onChange={setDayFilter} info={dayInfoMap(bookings.filter(b => b.paymentStatus && b.paymentStatus !== "none"), b => b.paymentSubmittedAt, "payment", b => b.total)} pending={{ count: payPendOther.length, day: payPendOther[0], label:"payments waiting for verification" }}/>
                {rows.map((b, i) => (
                  <React.Fragment key={b._id}>
                  {(i === 0 || istDayOf(rows[i-1].paymentSubmittedAt) !== istDayOf(b.paymentSubmittedAt)) && (() => { const k = istDayOf(b.paymentSubmittedAt), t = payDayTotals[k]; return <DayHeader C={C} day={k} left={`${t.n} payments · verified ${fmt(t.ok)}`} right={fmt(t.all)}/>; })()}
                  <div style={{ background:C.card, border:`1px solid ${b.paymentStatus==="pending_verification" ? C.amber+"66" : C.border}`, borderRadius:12, padding:14, marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                      <div>
                        <div style={{ fontWeight:800, fontSize:14 }}>{svcIcon(b.serviceType)} {b.customerName || "Customer"} · <span style={{ color:C.amber }}>₹{b.total}</span></div>
                        <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>Worker: {b.workerName || "—"} · {b.paymentLabel || "UPI"}</div>
                      </div>
                      <span style={{ background:(pc[b.paymentStatus]||C.muted)+"22", color:pc[b.paymentStatus]||C.muted, fontSize:10, fontWeight:800, padding:"3px 8px", borderRadius:20 }}>{pl[b.paymentStatus] || b.paymentStatus}</span>
                    </div>
                    <div style={{ background:C.card2, borderRadius:8, padding:"8px 12px", margin:"10px 0", fontSize:13 }}>
                      {b.utr
                        ? <>UTR: <b style={{ letterSpacing:1, fontFamily:"monospace" }}>{b.utr}</b></>
                        : <>No UTR given. Match in your UPI history by amount <b>₹{Number(b.total).toFixed(2)}</b> and note <b style={{ fontFamily:"monospace" }}>ProWorkers {String(b._id).slice(-6)}</b></>}
                    </div>
                    {b.paymentAuto && <div style={{ fontSize:12, color:C.green, fontWeight:700, marginBottom:8 }}>⚡ Auto-verified from UPI notification</div>}
                    {b.paymentStatus==="rejected" && b.paymentNote && <div style={{ fontSize:12, color:C.red, marginBottom:8 }}>{b.paymentNote}</div>}
                    <div style={{ fontSize:10, color:C.muted }}>Booking #{String(b._id).slice(-6)} · submitted {b.paymentSubmittedAt ? new Date(b.paymentSubmittedAt).toLocaleString("en-IN") : "—"}</div>
                    {b.paymentStatus==="pending_verification" && (
                      <div style={{ display:"flex", gap:8, marginTop:10 }}>
                        <button onClick={() => reviewPayment(b._id, "verify")} style={{ flex:1, background:C.green, border:"none", color:"#fff", borderRadius:8, padding:"9px 0", fontWeight:800, fontSize:12, cursor:"pointer" }}>✅ Verify</button>
                        <button onClick={() => reviewPayment(b._id, "reject")} style={{ flex:1, background:C.red+"22", border:`1px solid ${C.red}`, color:C.red, borderRadius:8, padding:"9px 0", fontWeight:800, fontSize:12, cursor:"pointer" }}>❌ Reject</button>
                      </div>
                    )}
                  </div>
                  </React.Fragment>
                ))}
              </div>
            );
          })()}

          {/* ── WORKER WITHDRAWALS ───────────────────────── */}
          {tab === "withdrawals" && (() => {
            const q = search.toLowerCase();
            const rows = withdrawals
              .filter(w => wdFilter === "all" || w.status === wdFilter)
              .filter(w => !q || w.workerName?.toLowerCase().includes(q) || w.upi?.toLowerCase().includes(q))
              .filter(w => q || istDayOf(w.createdAt) === activeDay);
            const wdPendOther = withdrawals.filter(w => w.status === "requested" && istDayOf(w.createdAt) !== activeDay).map(w => istDayOf(w.createdAt)).sort();
            const wdDayTotals = {};
            rows.forEach(w => { const k = istDayOf(w.createdAt); const t = wdDayTotals[k] || (wdDayTotals[k] = { n:0, all:0, paid:0, open:0 }); t.n++; t.all += w.amount || 0; if (w.status === "paid") t.paid += w.amount || 0; if (w.status === "requested") t.open += w.amount || 0; });
            const wc = { requested:C.amber, paid:C.green, rejected:C.red };
            const wl = { requested:"⏳ REQUESTED", paid:"✅ PAID", rejected:"❌ REJECTED" };
            return (
              <div>
                <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
                  {[["requested","Requested"],["paid","Paid"],["rejected","Rejected"],["all","All"]].map(([f,l]) => (
                    <button key={f} onClick={() => setWdFilter(f)} style={{ background: wdFilter===f ? C.amber : C.card2, border:`1px solid ${wdFilter===f ? C.amber : C.border}`, color: wdFilter===f ? "#000" : C.muted, borderRadius:20, padding:"4px 12px", fontSize:11, fontWeight:700, cursor:"pointer" }}>{l}</button>
                  ))}
                </div>
                <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>Pay the worker from your UPI app first, then press “Mark as paid”.</div>
                {rows.length === 0 && <div style={{ textAlign:"center", color:C.muted, padding:"30px 0", fontSize:13 }}>No withdrawal requests here.</div>}
                <DayFilter C={C} value={dayFilter} onChange={setDayFilter} info={dayInfoMap(withdrawals, w => w.createdAt, "request", w => w.amount)} pending={{ count: wdPendOther.length, day: wdPendOther[0], label:"payout requests waiting" }}/>
                {rows.map((w, i) => (
                  <React.Fragment key={w._id}>
                  {(i === 0 || istDayOf(rows[i-1].createdAt) !== istDayOf(w.createdAt)) && (() => { const k = istDayOf(w.createdAt), t = wdDayTotals[k]; return <DayHeader C={C} day={k} left={`${t.n} requests · paid ${fmt(t.paid)} · waiting ${fmt(t.open)}`} right={fmt(t.all)}/>; })()}
                  <div style={{ background:C.card, border:`1px solid ${w.status==="requested" ? C.amber+"66" : C.border}`, borderRadius:12, padding:14, marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                      <div>
                        <div style={{ fontWeight:800, fontSize:14 }}>{w.kind==="dues" ? "💰 Dues from " : "👷 "}{w.workerName || "Worker"} · <span style={{ color:C.amber }}>₹{w.amount}</span></div>
                        <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>{w.workerPhone || ""}</div>
                      </div>
                      <span style={{ background:(wc[w.status]||C.muted)+"22", color:wc[w.status]||C.muted, fontSize:10, fontWeight:800, padding:"3px 8px", borderRadius:20 }}>{wl[w.status] || w.status}</span>
                    </div>
                    <div style={{ background:C.card2, borderRadius:8, padding:"8px 12px", margin:"10px 0", fontSize:13 }}>
                      {w.kind==="dues" ? <>Worker says they paid us. Check your UPI for ₹{w.amount}{w.payoutUtr ? <> · UTR <b>{w.payoutUtr}</b></> : ""}, then press “Mark as paid”.</> : <>Pay to UPI: <b>{w.upi}</b></>}
                    </div>
                    {w.status==="paid" && w.payoutUtr && <div style={{ fontSize:12, color:C.green, marginBottom:6 }}>Payout UTR: {w.payoutUtr}</div>}
                    {w.status==="rejected" && w.adminNote && <div style={{ fontSize:12, color:C.red, marginBottom:6 }}>{w.adminNote}</div>}
                    <div style={{ fontSize:10, color:C.muted }}>Requested {new Date(w.createdAt).toLocaleString("en-IN")}</div>
                    {w.status==="requested" && (
                      <div style={{ display:"flex", gap:8, marginTop:10, flexWrap:"wrap" }}>
                        {w.kind!=="dues" && <a href={`upi://pay?${new URLSearchParams({ pa:w.upi, pn:w.workerName||"Worker", am:Number(w.amount).toFixed(2), cu:"INR", tn:"ProWorkers payout" })}`} style={{ flex:"1 1 100%", textAlign:"center", textDecoration:"none", background:C.card2, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:"9px 0", fontWeight:700, fontSize:12 }}>📱 Open in UPI app (on phone)</a>}
                        <button onClick={() => reviewWithdrawal(w._id, "paid")} style={{ flex:1, background:C.green, border:"none", color:"#fff", borderRadius:8, padding:"9px 0", fontWeight:800, fontSize:12, cursor:"pointer" }}>✅ Mark as paid</button>
                        <button onClick={() => reviewWithdrawal(w._id, "reject")} style={{ flex:1, background:C.red+"22", border:`1px solid ${C.red}`, color:C.red, borderRadius:8, padding:"9px 0", fontWeight:800, fontSize:12, cursor:"pointer" }}>❌ Reject</button>
                      </div>
                    )}
                  </div>
                  </React.Fragment>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Bottom nav */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, background:C.card, borderTop:`1px solid ${C.border}`, display:"flex", zIndex:50 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSearch(""); setDayFilter(""); }} style={{ flex:1, padding:"10px 0 8px", background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", position:"relative" }}>
            {t.badge > 0 && <span style={{ position:"absolute", top:4, left:"50%", marginLeft:6, background:C.red, color:"#fff", fontSize:9, fontWeight:800, minWidth:16, height:16, lineHeight:"16px", borderRadius:8, padding:"0 4px" }}>{t.badge}</span>}
            <div style={{ fontSize:18 }}>{t.icon}</div>
            <div style={{ fontSize:9, fontWeight:700, color:tab===t.id?C.amber:C.muted, marginTop:2 }}>{t.label}</div>
            {tab===t.id && <div style={{ height:2, background:C.amber, borderRadius:1, margin:"4px auto 0", width:20 }}/>}
          </button>
        ))}
      </div>
      {toast && <Toast msg={toast.msg} color={toast.color} onDone={() => setToast(null)}/>}
    </div>
  );
}

function ComplaintAdminCard({ complaint: c, onUpdate, C }) {
  const [note, setNote] = useState(c.adminNote || "");
  const [status, setStatus] = useState(c.status);
  const statusColor = { open:C.red, reviewing:C.amber, resolved:C.green, closed:C.muted }[status] || C.muted;
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 14px", marginBottom:12 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
        <div>
          <div style={{ fontWeight:800, fontSize:13 }}>🚨 {c.type?.replace("-"," ")?.toUpperCase() || "COMPLAINT"}</div>
          <div style={{ fontSize:12, color:C.muted }}>From {c.customerName} · re: {c.workerName || "Unknown worker"}</div>
        </div>
        <span style={{ background:statusColor+"22", color:statusColor, fontSize:10, fontWeight:800, padding:"3px 8px", borderRadius:20 }}>{status.toUpperCase()}</span>
      </div>
      <div style={{ fontSize:13, color:C.text, margin:"10px 0", padding:"8px 12px", background:C.card2, borderRadius:8 }}>{c.message}</div>
      <div style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
        {["open","reviewing","resolved","closed"].map(s => (
          <button key={s} onClick={() => setStatus(s)} style={{ background:status===s ? statusColor+"22" : C.card2, border:`1px solid ${status===s ? statusColor : C.border}`, color:status===s ? statusColor : C.muted, borderRadius:20, padding:"3px 10px", fontSize:11, fontWeight:700, cursor:"pointer" }}>{s}</button>
        ))}
      </div>
      <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Admin note…" rows={2} style={{ width:"100%", background:C.card2, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, fontSize:12, padding:"8px 10px", boxSizing:"border-box", resize:"none", outline:"none", fontFamily:"inherit" }}/>
      <button onClick={() => onUpdate(c._id, status, note)} style={{ marginTop:8, background:C.amber, border:"none", color:"#000", borderRadius:8, padding:"7px 18px", fontWeight:800, fontSize:12, cursor:"pointer" }}>Save Changes</button>
      <div style={{ fontSize:10, color:C.muted, marginTop:6 }}>Booking #{c.bookingId?.slice(-6)} · {new Date(c.createdAt).toLocaleDateString("en-IN")}</div>
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <LanguageProvider>
      <AppInner />
    </LanguageProvider>
  );
}

function AppInner() {
  const dark = useTheme();
  const C    = makeC(dark);
  const { t } = useLang();

  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem("pt_user");
      const token = localStorage.getItem("pt_token");
      if (saved && token) {
        const u = JSON.parse(saved);
        return { ...u, avatar: (u.name||u.email).slice(0,2).toUpperCase(), token };
      }
    } catch {}
    return null;
  });

  const [tab,       setTab]       = useState("home");
  const [rebook,    setRebook]    = useState(null);
  const [resume,    setResume]    = useState(null);   // an ongoing order the customer reopened
  usePushOpen(() => { if (user?.role === "customer") setTab("history"); });
  const [complaint, setComplaint] = useState(null);
  const [toast,     setToast]     = useState(null);
  const [showNotifBanner, setShowNotifBanner] = useState(() => !localStorage.getItem("pt_notif_perm"));

  // Register this phone for push notifications whenever someone is logged in
  useEffect(() => { if (user?.id) setupPush(); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bookings now come from the real backend — no fake/local-only bookings.
  const [bookings, setBookings] = useState([]);
  const prevPayStatus = useRef(null); // paymentStatus per booking, to alert on admin decisions

  async function loadBookings(u) {
    if (!u) { setBookings([]); return; }
    try {
      const data = await apiGet(`/bookings/customer/${u.id}`);
      // Only trust a real array response. Never clear existing bookings just
      // because of a transient network hiccup — that's what made bookings
      // appear to "vanish" on a slow connection or brief server blip.
      if (Array.isArray(data)) {
        const list = data.map(normalizeBooking);
        if (prevPayStatus.current) {
          list.forEach(b => {
            if (prevPayStatus.current[b.id] !== "pending_verification") return;
            if (b.paymentStatus === "verified") {
              pushNotif("Payment Verified ✅", `₹${b.total} received. Thank you!`);
              setToast({ msg:`✅ Payment of ₹${b.total} verified.`, color:C.green });
            } else if (b.paymentStatus === "rejected") {
              pushNotif("Payment Rejected ❌", b.paymentNote || "We could not verify your payment. Please pay again.");
              setToast({ msg:"❌ Payment rejected. Please pay again.", color:C.red });
            }
          });
        }
        prevPayStatus.current = Object.fromEntries(list.map(b => [b.id, b.paymentStatus]));
        setBookings(list);
      }
    } catch {
      // Swallow transient errors silently; keep showing the last known list.
    }
  }

  useEffect(() => {
    if (!user) return;
    loadBookings(user);
    const t = setInterval(() => loadBookings(user), 8000); // catch worker status/completion changes
    return () => clearInterval(t);
    // Re-subscribe whenever the logged-in user changes (login/logout/switch account).
    // Previously this ran once with an empty dependency array, so logging in after
    // the initial render (no full page reload) never started the polling — bookings
    // would never load and appeared to "vanish".
  }, [user?.id]);

  function addBooking(bk) {
    setBookings(prev => [bk, ...prev]);
    pushNotif("Booking Confirmed! ✅", `Worker ${bk.workerName} is on the way. Booking #${bk.id}`);
  }

  // ── Mandatory payment gate ──────────────────────────────────────────────
  // Payment can never be skipped once a job is marked "completed" by the worker.
  // If the customer didn't pay earlier, the moment we see a completed+unpaid
  // booking we block the app behind a payment modal that cannot be dismissed.
  //
  // Cash is special: once the customer commits to "Cash on Completion", the
  // booking sits with paid:false + paymentMethod:"cash" + cashConfirmed:null
  // until the worker confirms they actually received the money. During that
  // window the customer should see a "waiting on worker" screen, NOT be asked
  // to choose a payment method again (that was the old bug — the gate kept
  // re-appearing and re-prompting for payment even after cash was selected).
  // If the worker says they did NOT receive it, cashConfirmed becomes false
  // and paymentMethod is cleared server-side, so the customer correctly falls
  // back into "needs to choose/pay again".
  const awaitingCashConfirmation = bookings.find(b =>
    b.status === "completed" && !b.paid && b.paymentMethod === "cash" && b.cashConfirmed !== false
  );
  const awaitingVerification = bookings.find(b =>
    (b.status === "completed" || (b.status === "cancelled" && b.cancelFee > 0)) && !b.paid && b.paymentStatus === "pending_verification"
  );
  const duePayment = bookings.find(b =>
    (b.status === "completed" && !b.paid && b.paymentStatus !== "pending_verification" && !(b.paymentMethod === "cash" && b.cashConfirmed !== false)) ||
    (b.status === "cancelled" && b.cancelFee > 0 && !b.paid && b.paymentStatus !== "pending_verification")   // travel fee after a late cancellation
  );
  const [forcedPayBusy, setForcedPayBusy] = useState(false);
  // Keep the payment modal open through the rating step after a UTR is submitted
  // (the booking stops being "due" the moment the UTR is saved).
  const [forcedFlowId, setForcedFlowId] = useState(null);
  const payTarget = duePayment || (forcedFlowId ? bookings.find(b => b.id === forcedFlowId) : null);

  async function submitUtrForDue(method, label, utr) {
    const updated = await apiSubmitUtr(duePayment.id, method, label, utr);
    setForcedFlowId(updated.id);
    setBookings(prev => prev.map(b => b.id === updated.id ? updated : b));
    pushNotif("Payment Submitted ⏳", `₹${updated.total} — waiting for admin to verify your UTR.`);
  }

  async function handleForcedPay(method, label, rating) {
    // UPI: UTR already submitted via submitUtrForDue — only the optional rating is left.
    if (method.startsWith("upi_")) {
      const id = payTarget?.id;
      if (id) {
        try {
          if (rating) await apiPatch(`/bookings/${id}`, { userRating: rating });
          const upd = normalizeBooking(await apiGet(`/bookings/${id}`));
          setBookings(prev => prev.map(b => b.id === upd.id ? upd : b));
        } catch {}
      }
      setForcedFlowId(null);
      return;
    }
    if (!duePayment) return;
    setForcedPayBusy(true);
    try {
      const isCash = method === "cash";
      const payload = isCash
        ? { paymentMethod: method, paymentLabel: label, paid: false, cashConfirmed: null }
        : { paid: true, paymentMethod: method, paymentLabel: label };
      if (rating) payload.userRating = rating;
      const res = await apiPatch(`/bookings/${duePayment.id}`, payload);
      const updated = normalizeBooking(res.booking);
      setBookings(prev => prev.map(b => b.id === updated.id ? updated : b));
      if (isCash) {
        pushNotif("Cash Payment Selected", `₹${updated.total} due in cash — you'll be marked as paid once the worker confirms they received it.`);
      } else {
        pushNotif("Payment Done ✅", `₹${updated.total} paid via ${label}. Thank you!`);
      }
    } catch (e) {
      setToast({ msg:"⚠️ Payment failed. Please try again.", color:C.red });
    }
    setForcedPayBusy(false);
  }

  function handleAuth(u) {
    // Server now stores profile edits (name, phone, location, photo, workerType)
    // so just use the server response directly — no localStorage merge needed.
    localStorage.setItem("pt_user", JSON.stringify(u));
    setUser(u);
    setTab("home");
    loadBookings(u);
  }

  function handleLogout() {
    teardownPush();   // stop pushes for this account on this phone (reads the token before it is removed)
    localStorage.removeItem("pt_token");
    localStorage.removeItem("pt_user");  // server is source of truth now; fresh login fetches latest
    setUser(null); setTab("home"); setBookings([]);
  }

  function handleUpdateUser(updated) {
    // Always persist token alongside profile so it survives re-read
    const toSave = { ...updated, token: undefined };
    setUser({ ...updated, token: user?.token || updated.token });
    localStorage.setItem("pt_user", JSON.stringify(toSave));
    setToast({ msg:"✅ Profile updated!", color:C.green });
  }

  if (!user) return <AuthScreen onAuth={handleAuth}/>;

  const isWorker = user.role === "worker";
  const isAdmin  = user.role === "admin";

  // ── Admin App ───────────────────────────────────────────
  if (isAdmin) {
    return <AdminApp user={user} onLogout={handleLogout} C={C} toast={toast} setToast={setToast}/>;
  }

  // ── Worker App ──────────────────────────────────────────
  if (isWorker) {
    return <WorkerApp user={user} onLogout={handleLogout} onUpdateUser={handleUpdateUser} C={C} toast={toast} setToast={setToast}/>;
  }

  // ── Customer App ────────────────────────────────────────
  const TABS = [
    {id:"home",    icon:"🏠", label:t("nav_home")},
    {id:"book",    icon:"🛠️", label:t("nav_book")},
    {id:"history", icon:"📋", label:t("nav_bookings")},
    {id:"profile", icon:"👤", label:t("nav_profile")},
  ];

  let content;
  if      (tab==="book")    content = <BookingFlow key={resume?.id || rebook?.id || "new"} user={user} prefill={rebook} resume={resume} onBack={() => { setRebook(null); setResume(null); setTab("home"); }} onBooked={bk => { setRebook(null); setResume(null); addBooking(bk); setTab("history"); }} C={C}/>;
  else if (tab==="history") content = <HistoryScreen bookings={bookings} onRebook={b => { setRebook(b); setTab("book"); }} onComplaint={setComplaint} onRated={updated => setBookings(prev => prev.map(b => b.id === updated.id ? updated : b))} C={C}/>;
  else if (tab==="profile") content = <ProfileScreen user={user} onLogout={handleLogout} onUpdateUser={handleUpdateUser} C={C}/>;
  else                      content = <HomeScreen user={user} bookings={bookings} setTab={setTab} onOpenOrder={b => { setRebook(null); setResume(b); setTab("book"); }} C={C}/>;

  return (
    <div style={{ minHeight:"100vh", background:C.bg, fontFamily:"'Inter',system-ui,sans-serif", color:C.text, paddingBottom:72 }}>
      <div style={{ background:C.card, borderBottom:"1px solid "+C.border, padding:"10px 16px", position:"sticky", top:0, zIndex:50, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <Logo size={22}/>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <Av initials={user.avatar} color={C.amber} size={28} photo={user.photo}/>
          <span style={{ color:C.muted, fontSize:12 }}>{user.name}</span>
        </div>
      </div>
      <div style={{ minHeight:"calc(100vh - 120px)" }}>{content}</div>
      <div style={{ position:"fixed", bottom:0, left:0, right:0, background:C.card, borderTop:"1px solid "+C.border, display:"flex", zIndex:50 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ flex:1, padding:"10px 0 8px", background:"none", border:"none", cursor:"pointer", fontFamily:"inherit" }}>
            <div style={{ fontSize:18 }}>{t.icon}</div>
            <div style={{ fontSize:9, fontWeight:700, color:tab===t.id?C.amber:C.muted, marginTop:2 }}>{t.label}</div>
            {tab===t.id && <div style={{ height:2, background:C.amber, borderRadius:1, margin:"4px auto 0", width:20 }}/>}
          </button>
        ))}
      </div>
      {complaint && (
        <ComplaintModal
          booking={complaint}
          onClose={() => setComplaint(null)}
          onSubmit={async (type, message) => {
            try {
              await apiPost("/complaints", {
                customerId: user.id, customerName: user.name,
                bookingId: complaint.id, workerName: complaint.workerName,
                type, message,
              });
              setToast({ msg:"✅ Complaint submitted. We review in 24h.", color:C.green });
            } catch (e) {
              setToast({ msg:"⚠️ Could not submit complaint. Try again.", color:C.red });
            }
          }}
          C={C}
        />
      )}
      {toast && <Toast msg={toast.msg} color={toast.color} onDone={() => setToast(null)}/>}
      {showNotifBanner && <NotificationBanner C={C} onDismiss={(granted) => { setShowNotifBanner(false); if(granted) pushNotif("ProWorkers Notifications On", "You'll get alerts for bookings, payments & more."); }}/>}

      {/* Mandatory payment — job is done, payment cannot be skipped */}
      {awaitingCashConfirmation && (
        <div style={{ position:"fixed", inset:0, zIndex:400, background:"rgba(0,0,0,0.82)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:C.card, borderRadius:20, padding:28, width:"100%", maxWidth:390, border:`1px solid ${C.border}`, textAlign:"center" }}>
            <div style={{ fontSize:52 }}>⏳</div>
            <div style={{ color:C.amber, fontWeight:900, fontSize:19, marginTop:12 }}>Waiting for Cash Confirmation</div>
            <div style={{ color:C.muted, fontSize:13, marginTop:8, lineHeight:1.5 }}>
              You chose to pay ₹{awaitingCashConfirmation.total} in cash to {awaitingCashConfirmation.workerName || "the worker"}. This will be marked as paid as soon as they confirm they received it.
            </div>
          </div>
        </div>
      )}
      {!awaitingCashConfirmation && awaitingVerification && !payTarget && (
        <div style={{ position:"fixed", inset:0, zIndex:400, background:"rgba(0,0,0,0.82)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:C.card, borderRadius:20, padding:28, width:"100%", maxWidth:390, border:`1px solid ${C.border}`, textAlign:"center" }}>
            <div style={{ fontSize:52 }}>⏳</div>
            <div style={{ color:C.amber, fontWeight:900, fontSize:19, marginTop:12 }}>Verifying Your Payment</div>
            <div style={{ color:C.muted, fontSize:13, marginTop:8, lineHeight:1.5 }}>
              We received your payment confirmation for ₹{awaitingVerification.total}. This screen closes as soon as the admin verifies it.
            </div>
          </div>
        </div>
      )}
      {!awaitingCashConfirmation && payTarget && (
        <div style={{ position:"fixed", inset:0, zIndex:400 }}>
          <div style={{ position:"fixed", top:0, left:0, right:0, background:C.amber, color:"#0D1117", textAlign:"center", padding:"10px 16px", fontWeight:800, fontSize:13, zIndex:401 }}>
            {payTarget.paymentStatus==="pending_verification" ? "⏳ Payment submitted — waiting for verification." : payTarget.paymentStatus==="rejected" ? `❌ ${payTarget.paymentNote || "Payment rejected."} Pay ₹${payTarget.total} again to continue.` : payTarget.cancelFee > 0 ? `🔒 Pay the ₹${payTarget.total} travel fee for your cancelled booking to continue.` : `🔒 Your job is complete — payment of ₹${payTarget.total} is required to continue.`}
          </div>
          <PaymentModal
            noCash={payTarget.cancelFee > 0} total={payTarget.total - (payTarget.cashSurcharge||0)} cashCharge={payTarget.cancelFee > 0 ? 0 : cashChargeFor(payTarget)} jobTotal={payTarget.jobTotal} platformMarkup={payTarget.platformFee - (payTarget.cashSurcharge||0)}
            svc={SERVICES[payTarget.serviceType] || SERVICES.electrician}
            workerName={payTarget.workerName} workerAvatar={payTarget.workerAvatar}
            bookingId={payTarget.id} onSubmitUtr={submitUtrForDue}
            onPay={handleForcedPay} onClose={() => {}} C={C}
          />
        </div>
      )}
    </div>
  );
}
