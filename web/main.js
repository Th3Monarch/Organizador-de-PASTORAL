import * as THREE from "three";

/* ============================================================
   URL DE DESCARGA
   Cambia USUARIO/REPO y el nombre del archivo por los tuyos.
   Si usas GitHub Releases, este enlace siempre apunta a la
   última versión del instalador.
   ============================================================ */
const DOWNLOAD_URL =
  "https://github.com/Th3Monarch/Organizador-de-PASTORAL/releases/download/v1.1.0/Organizador-Pastoral-Setup-1.1.0.exe";

/* ---------- Enlaces de descarga ---------- */
document.querySelectorAll("[data-download]").forEach((a) => {
  a.setAttribute("href", DOWNLOAD_URL);
  a.setAttribute("download", "");
  a.setAttribute("rel", "noopener");
});

/* ---------- Año del pie ---------- */
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

/* ---------- Animaciones al hacer scroll ---------- */
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const reveals = document.querySelectorAll(".reveal");

if (reduceMotion || !("IntersectionObserver" in window)) {
  reveals.forEach((el) => el.classList.add("in"));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.14, rootMargin: "0px 0px -40px 0px" }
  );
  reveals.forEach((el) => io.observe(el));

  // Respaldo: revela lo que ya quedó por encima del pliegue (p. ej. al saltar).
  let ticking = false;
  const sweep = () => {
    ticking = false;
    const limit = window.innerHeight * 0.92;
    reveals.forEach((el) => {
      if (!el.classList.contains("in") && el.getBoundingClientRect().top < limit) {
        el.classList.add("in");
        io.unobserve(el);
      }
    });
  };
  const onScroll = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(sweep);
    }
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  sweep();
}

/* ============================================================
   ESCENA 3D (Three.js)
   ============================================================ */
function initScene() {
  const canvas = document.getElementById("scene");
  if (!canvas) return;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    canvas.style.display = "none";
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0.4, 6.4);

  const group = new THREE.Group();
  scene.add(group);

  /* Núcleo */
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.5, 1),
    new THREE.MeshStandardMaterial({
      color: 0x6b7bff,
      metalness: 0.4,
      roughness: 0.25,
      emissive: 0x2a2f7a,
      emissiveIntensity: 0.7,
      flatShading: true,
    })
  );
  group.add(core);

  /* Malla exterior */
  const wire = new THREE.Mesh(
    new THREE.IcosahedronGeometry(2.05, 1),
    new THREE.MeshBasicMaterial({
      color: 0x9aa6ff,
      wireframe: true,
      transparent: true,
      opacity: 0.3,
    })
  );
  group.add(wire);

  /* Satélites (los módulos de la app) */
  const satColors = [0x6b7bff, 0x8a7bff, 0xf5a623, 0x5fd08a, 0x6b7bff, 0x8a7bff];
  const satellites = [];
  const satGeo = new THREE.SphereGeometry(0.085, 18, 18);
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: satColors[i],
      emissive: satColors[i],
      emissiveIntensity: 0.55,
      roughness: 0.4,
    });
    const s = new THREE.Mesh(satGeo, mat);
    const angle = (i / 6) * Math.PI * 2;
    s.position.set(Math.cos(angle) * 2.7, Math.sin(angle) * 1.15, Math.sin(angle) * 1.1);
    group.add(s);
    satellites.push(s);
  }

  /* Polvo de estrellas */
  const starCount = 700;
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 9 + Math.random() * 14;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const starGeo = new THREE.BufferGeometry();
  satGeo.dispose();
  const stars = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(positions, 3)),
    new THREE.PointsMaterial({ color: 0xaab4ff, size: 0.045, transparent: true, opacity: 0.75 })
  );
  scene.add(stars);

  /* Luces */
  scene.add(new THREE.AmbientLight(0x8890c0, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(4, 5, 6);
  scene.add(key);
  const rim = new THREE.PointLight(0x6b7bff, 22, 26);
  rim.position.set(-4, -2, 3);
  scene.add(rim);
  const warm = new THREE.PointLight(0xf5a623, 12, 22);
  warm.position.set(-3, 4, -4);
  scene.add(warm);

  /* Colocación responsiva */
  const pointer = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  function place() {
    const wide = window.innerWidth > 900;
    const x = wide ? 2.0 : 0;
    const y = wide ? 0.1 : 0.9;
    group.position.set(x, y, 0);
    camera.position.z = wide ? 6.4 : 7.2;
    camera.lookAt(x, y, 0);
  }
  place();

  /* Interacción del ratón */
  if (!reduceMotion) {
    window.addEventListener("pointermove", (e) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    });
  }

  function onResize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    place();
  }
  window.addEventListener("resize", onResize);

  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    const t = clock.elapsedTime;

    group.rotation.y += dt * 0.35;
    core.rotation.x += dt * 0.12;
    core.rotation.z += dt * 0.08;
    wire.rotation.y -= dt * 0.55;
    wire.rotation.x += dt * 0.05;
    stars.rotation.y += dt * 0.02;

    satellites.forEach((s, i) => {
      const a = (i / satellites.length) * Math.PI * 2 + t * 0.4;
      s.position.set(Math.cos(a) * 2.6, Math.sin(a * 1.3) * 0.9, Math.sin(a) * 2.6 * 0.35);
    });

    target.x += (pointer.x - target.x) * 0.05;
    target.y += (pointer.y - target.y) * 0.05;
    group.rotation.x = target.y * 0.25;
    group.rotation.z = -target.x * 0.12;

    renderer.render(scene, camera);
  }

  if (reduceMotion) {
    renderer.render(scene, camera);
  } else {
    animate();
  }
}

initScene();
