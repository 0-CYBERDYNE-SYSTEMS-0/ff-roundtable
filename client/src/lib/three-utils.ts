import * as THREE from "three";

// Initialize a Three.js scene
export function initThreeScene(container: HTMLElement) {
  // Create scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f5);
  
  // Set up camera
  const camera = new THREE.PerspectiveCamera(
    75,
    container.clientWidth / container.clientHeight,
    0.1,
    1000
  );
  camera.position.set(0, 12, 0);
  camera.lookAt(0, 0, 0);
  
  // Set up renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  
  // Add lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(0, 10, 10);
  scene.add(directionalLight);
  
  // Create table
  const table = createTable();
  scene.add(table);
  
  return { scene, camera, renderer, table };
}

// Create the roundtable
export function createTable() {
  const tableGeometry = new THREE.CylinderGeometry(5, 5, 0.5, 32);
  const tableMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x8BC34A,
    roughness: 0.7,
    metalness: 0.2
  });
  const table = new THREE.Mesh(tableGeometry, tableMaterial);
  
  // Add table legs
  const legGeometry = new THREE.CylinderGeometry(0.2, 0.2, 3, 16);
  const legMaterial = new THREE.MeshStandardMaterial({ color: 0x5D4037 });
  
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const radius = 4;
    
    const x = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    
    const leg = new THREE.Mesh(legGeometry, legMaterial);
    leg.position.set(x, -1.75, z);
    table.add(leg);
  }
  
  return table;
}

// Create expert avatar mesh
export function createExpertAvatar(index: number, role: string) {
  // Create expert avatar
  const expertGeometry = new THREE.SphereGeometry(0.7, 32, 32);
  const expertMaterial = new THREE.MeshStandardMaterial({ 
    color: getExpertColor(index, role),
    roughness: 0.7,
    metalness: 0.3
  });
  
  const expert = new THREE.Mesh(expertGeometry, expertMaterial);
  
  // Create expert base/stand
  const standGeometry = new THREE.CylinderGeometry(0.3, 0.4, 0.8, 16);
  const standMaterial = new THREE.MeshStandardMaterial({ color: 0x616161 });
  const stand = new THREE.Mesh(standGeometry, standMaterial);
  stand.position.y = -0.4;
  expert.add(stand);
  
  return expert;
}

// Get expert color based on role
function getExpertColor(index: number, role: string): number {
  const roleColors: Record<string, number> = {
    "Soil Scientist": 0x2E7D32, // Green
    "Crop Specialist": 0xF57C00, // Orange
    "Irrigation Engineer": 0x1976D2, // Blue
    "Pest Management": 0xD32F2F, // Red
    "Meteorologist": 0x388E3C, // Green
    "File Creator": 0x0288D1, // Blue
    "Research Analyst": 0x7B1FA2, // Purple
    "Imagery Specialist": 0xFFA000, // Amber
    "Moderator": 0x5D4037, // Brown
  };
  
  if (role in roleColors) {
    return roleColors[role];
  }
  
  // Fallback colors if role not found
  const fallbackColors = [
    0x2E7D32, // Green
    0xF57C00, // Orange
    0x1976D2, // Blue
    0xD32F2F, // Red
    0x7B1FA2, // Purple
    0x388E3C, // Green
    0x0288D1, // Blue
    0xFFA000  // Amber
  ];
  
  return fallbackColors[index % fallbackColors.length];
}
