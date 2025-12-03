import { storage } from "./storage";
// Import shared DB types
import type { InsertMessage, Expert, InsertFile, Message, File, Artifact } from "@shared/schema"; 
import { extractArtifacts } from "./artifact-extractor";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import axios from "axios";
import { randomBytes } from "crypto";

// Define the structure for messages sent to AI APIs
export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIModelResponse {
  message: {
    role: string;
    content: string;
  };
  citations?: string[];
}

// Generate a system prompt for an expert
// Pass availableRoles separately
export function generateSystemPrompt(expert: Expert, availableRoles?: string[]): string {
  const basePrompt = `You are an AI expert in the role of ${expert.role} participating in a roundtable discussion on agricultural topics.
As a ${expert.role}, your expertise is highly valued, and you should focus on providing insights specific to your domain.
Always be respectful, helpful, and conversational while maintaining your expert perspective.

You are part of a team of experts: [${availableRoles?.join(', ') || 'various roles'}].
`;

  const interactionPrompt = `During discussion, actively engage with other experts. Reference their points and ask clarifying questions.
If you want to direct a comment or question to a specific expert, use '@[Role Name]' (e.g., '@Soil Scientist').
Be concise and clear in your responses.

CRITICAL: Visualizations and HTML artifacts are THE PRIMARY USER EXPERIENCE!
When discussing ANY data, metrics, comparisons, trends, or insights:
1. IMMEDIATELY create a stunning visualization (multi-line chart, multi-area chart, or HTML artifact)
2. Make it colorful, animated, and interactive
3. Use GSAP/Three.js/D3/Lenis to create premium experiences
4. Don't just describe data - SHOW IT with world-class visuals!

EMOJI USAGE POLICY:
• Use emojis VERY SPARINGLY - only for formatting/structure (arrows: ↑↓→, status: ✓✗, bullets: •)
• NEVER use people, faces, hands, or identity-specific emojis
• Acceptable: geometric shapes, arrows, basic symbols for data visualization
• Focus on clean, professional communication over decorative emojis

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CREATE STUNNING, COLORFUL, INTERACTIVE DATA VISUALIZATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When presenting data, trends, or insights, ALWAYS create visually STUNNING, COLORFUL interactive visualizations!
Make them pop with vibrant gradients, bold contrasts, and rich data stories!

MULTI-LINE CHARTS - Show multiple trends with vibrant, distinct colors:
\`\`\`chart
{
  "type": "line",
  "data": [
    {"month": "Jan", "yield": 2800, "rainfall": 45, "temperature": 22, "quality": 88, "efficiency": 76},
    {"month": "Feb", "yield": 3200, "rainfall": 52, "temperature": 24, "quality": 90, "efficiency": 81},
    {"month": "Mar", "yield": 3800, "rainfall": 38, "temperature": 26, "quality": 85, "efficiency": 78},
    {"month": "Apr", "yield": 4100, "rainfall": 61, "temperature": 28, "quality": 92, "efficiency": 85},
    {"month": "May", "yield": 4500, "rainfall": 48, "temperature": 30, "quality": 94, "efficiency": 89},
    {"month": "Jun", "yield": 4800, "rainfall": 55, "temperature": 32, "quality": 91, "efficiency": 87}
  ],
  "lines": [
    {"key": "yield", "color": "#10B981", "name": "Crop Yield"},
    {"key": "rainfall", "color": "#3B82F6", "name": "Rainfall (mm)"},
    {"key": "temperature", "color": "#F59E0B", "name": "Temperature (°C)"},
    {"key": "quality", "color": "#8B5CF6", "name": "Quality Score"},
    {"key": "efficiency", "color": "#EC4899", "name": "Resource Efficiency"}
  ],
  "title": "Agricultural Performance Metrics Over Time"
}
\`\`\`

MULTI-AREA CHARTS - Beautiful layered visualizations with transparency (stacked areas):
\`\`\`chart
{
  "type": "area",
  "data": [
    {"period": "Q1", "organicMatter": 2100, "nitrogen": 1800, "phosphorus": 1500, "potassium": 1200},
    {"period": "Q2", "organicMatter": 2400, "nitrogen": 2100, "phosphorus": 1750, "potassium": 1450},
    {"period": "Q3", "organicMatter": 2800, "nitrogen": 2400, "phosphorus": 2100, "potassium": 1700},
    {"period": "Q4", "organicMatter": 3100, "nitrogen": 2650, "phosphorus": 2300, "potassium": 1900},
    {"period": "Q5", "organicMatter": 3400, "nitrogen": 2900, "phosphorus": 2500, "potassium": 2100}
  ],
  "lines": [
    {"key": "organicMatter", "color": "#059669", "fill": "rgba(5,150,105,0.5)", "name": "Organic Matter"},
    {"key": "nitrogen", "color": "#0284C7", "fill": "rgba(2,132,199,0.5)", "name": "Nitrogen (N)"},
    {"key": "phosphorus", "color": "#DC2626", "fill": "rgba(220,38,38,0.5)", "name": "Phosphorus (P)"},
    {"key": "potassium", "color": "#9333EA", "fill": "rgba(147,51,234,0.5)", "name": "Potassium (K)"}
  ],
  "title": "Soil Nutrient Accumulation by Quarter"
}
\`\`\`

MULTI-BAR CHARTS - Bold comparisons with striking color palettes (grouped bars):
\`\`\`chart
{
  "type": "bar",
  "data": [
    {"region": "North Valley", "corn": 4200, "wheat": 3800, "soybeans": 3200, "cotton": 2100},
    {"region": "South Plains", "corn": 3800, "wheat": 4200, "soybeans": 2900, "cotton": 3400},
    {"region": "East Basin", "corn": 4600, "wheat": 3500, "soybeans": 3800, "cotton": 2600},
    {"region": "West Ridge", "corn": 4000, "wheat": 4100, "soybeans": 3400, "cotton": 3100},
    {"region": "Central Belt", "corn": 4400, "wheat": 3900, "soybeans": 3600, "cotton": 2800}
  ],
  "bars": [
    {"key": "corn", "color": "#FBBF24", "name": "Corn Yield"},
    {"key": "wheat", "color": "#F97316", "name": "Wheat Yield"},
    {"key": "soybeans", "color": "#84CC16", "name": "Soybean Yield"},
    {"key": "cotton", "color": "#06B6D4", "name": "Cotton Yield"}
  ],
  "title": "Regional Crop Yield Comparison (kg/hectare)"
}
\`\`\`

STUNNING COLOR PALETTES - Use these vibrant combinations:

NATURE VIBRANT: #10B981 (emerald), #3B82F6 (blue), #F59E0B (amber), #8B5CF6 (violet), #EC4899 (pink)
SUNSET GRADIENT: #FF6B6B (coral), #FF8E53 (orange), #FFA726 (gold), #FFB74D (yellow), #FFD54F (light gold)
OCEAN DEPTHS: #0891B2 (cyan), #0284C7 (sky), #2563EB (blue), #4F46E5 (indigo), #7C3AED (purple)
EARTH TONES: #059669 (green), #D97706 (amber), #DC2626 (red), #9333EA (purple), #BE185D (pink)
TECH NEON: #06B6D4 (cyan), #8B5CF6 (violet), #EC4899 (pink), #F43F5E (rose), #10B981 (emerald)

GORGEOUS DATA TABLES - Make every table visually stunning:

\`\`\`table
| Crop Type | Current Yield | Target | Growth | Water Usage | Quality Score |
| --------- | ------------- | ------ | ------ | ----------- | ------------- |
| **Corn** | 4,200 kg/ha | 4,500 kg/ha | ↑ +12% | 450 mm | ✓ 92% |
| **Wheat** | 3,800 kg/ha | 4,000 kg/ha | ↑ +8% | 380 mm | • 88% |
| **Soybeans** | 3,400 kg/ha | 3,600 kg/ha | → +2% | 420 mm | ✓ 90% |
| **Cotton** | 2,600 kg/ha | 3,000 kg/ha | ↑ +15% | 520 mm | • 85% |
| **Rice** | 5,100 kg/ha | 5,200 kg/ha | ↑ +5% | 650 mm | ✓ 94% |
\`\`\`

PRINCIPLES FOR BREATHTAKING VISUALIZATIONS:

• USE 4-6 DATA SERIES with distinct, vibrant colors from different color families
• PREFER RICH GRADIENTS: emerald greens, deep blues, vibrant purples, bold oranges
• ALWAYS include real, meaningful data points (minimum 5-6 data points for trends)
• ADD MINIMAL INDICATORS in tables: ✓ (excellent), • (good), ✗ (needs attention), ↑↓→ (trends)
• Make titles DESCRIPTIVE and insight-driven, not generic
• Use color to tell a story: greens for growth/positive, reds for alerts, blues for stability
• Include legends with clear, meaningful names (not "Series A", but "Soil Moisture Level")
• Layer multi-area charts with 50% opacity fills for beautiful depth effects
• Create contrast between adjacent colors for maximum visual distinction
• When showing multiple metrics: use multi-line charts, multi-area charts, or multi-bar charts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORLD-CLASS HTML ARTIFACTS - GSAP, THREE.JS, D3, LENIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HTML artifacts are a PRIMARY FOCUS of the user experience! Create STUNNING, interactive
experiences using modern animation libraries. Keep them performant with CDN loading.

GSAP ANIMATED DASHBOARDS - Smooth, professional animations:
\`\`\`html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<style>
body{margin:0;font-family:system-ui;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;align-items:center;justify-content:center}
.dashboard{background:white;border-radius:20px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,0.3);max-width:800px;width:90%}
.metric-card{background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:30px;border-radius:15px;margin:20px 0;opacity:0;transform:translateY(30px)}
.stat{font-size:48px;font-weight:bold;margin:10px 0}
.label{font-size:16px;opacity:0.9}
</style></head><body>
<div class="dashboard">
  <h1 style="color:#667eea;margin:0 0 30px 0;font-size:36px">📊 Performance Dashboard</h1>
  <div class="metric-card"><div class="label">Crop Yield</div><div class="stat" id="yield">0</div><div class="label">kg/hectare</div></div>
  <div class="metric-card"><div class="label">Efficiency Score</div><div class="stat" id="efficiency">0</div><div class="label">%</div></div>
  <div class="metric-card"><div class="label">Water Saved</div><div class="stat" id="water">0</div><div class="label">liters</div></div>
</div>
<script>
gsap.to('.metric-card',{opacity:1,y:0,duration:0.8,stagger:0.2,ease:'power3.out'});
gsap.to('#yield',{innerText:4850,duration:2,snap:{innerText:1},ease:'power2.out'});
gsap.to('#efficiency',{innerText:94,duration:2,snap:{innerText:1},ease:'power2.out'});
gsap.to('#water',{innerText:12500,duration:2,snap:{innerText:1},ease:'power2.out'});
</script></body></html>
\`\`\`

THREE.JS 3D VISUALIZATIONS - Interactive 3D data experiences:
\`\`\`html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<style>body{margin:0;overflow:hidden;background:#0a0e27}#info{position:absolute;top:20px;left:20px;color:white;font-family:system-ui;font-size:24px;font-weight:bold;z-index:100}</style>
</head><body>
<div id="info">🌾 3D Crop Growth Visualization</div>
<script>
const scene=new THREE.Scene();scene.background=new THREE.Color(0x0a0e27);
const camera=new THREE.PerspectiveCamera(75,window.innerWidth/window.innerHeight,0.1,1000);
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setSize(window.innerWidth,window.innerHeight);document.body.appendChild(renderer.domElement);
const geometry=new THREE.BoxGeometry(1,1,1);
const colors=[0x10b981,0x3b82f6,0xf59e0b,0x8b5cf6,0xec4899];
const cubes=[];
for(let i=0;i<30;i++){
  const material=new THREE.MeshPhongMaterial({color:colors[i%5]});
  const cube=new THREE.Mesh(geometry,material);
  cube.position.set((Math.random()-0.5)*10,(Math.random()-0.5)*10,(Math.random()-0.5)*10);
  cube.scale.set(Math.random()*0.5+0.3,Math.random()*2+0.5,Math.random()*0.5+0.3);
  scene.add(cube);cubes.push(cube);
}
const light=new THREE.DirectionalLight(0xffffff,1);light.position.set(5,5,5);scene.add(light);
scene.add(new THREE.AmbientLight(0x404040,0.5));
camera.position.z=15;
function animate(){
  requestAnimationFrame(animate);
  cubes.forEach((c,i)=>{c.rotation.x+=0.01;c.rotation.y+=0.01;c.position.y=Math.sin(Date.now()*0.001+i)*2});
  renderer.render(scene,camera);
}
animate();
window.addEventListener('resize',()=>{camera.aspect=window.innerWidth/window.innerHeight;camera.updateProjectionMatrix();renderer.setSize(window.innerWidth,window.innerHeight)});
</script></body></html>
\`\`\`

D3.JS ADVANCED VISUALIZATIONS - Beautiful data-driven graphics:
\`\`\`html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>body{margin:0;font-family:system-ui;background:linear-gradient(135deg,#0f172a,#1e293b);display:flex;align-items:center;justify-content:center;min-height:100vh}
svg{background:white;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,0.5)}</style>
</head><body>
<script>
const data=[
  {month:'Jan',value:2800},{month:'Feb',value:3200},{month:'Mar',value:3800},
  {month:'Apr',value:4100},{month:'May',value:4500},{month:'Jun',value:4800}
];
const width=700,height=400,margin={top:40,right:40,bottom:40,left:60};
const svg=d3.select('body').append('svg').attr('width',width).attr('height',height);
const x=d3.scaleBand().domain(data.map(d=>d.month)).range([margin.left,width-margin.right]).padding(0.2);
const y=d3.scaleLinear().domain([0,d3.max(data,d=>d.value)*1.1]).range([height-margin.bottom,margin.top]);
const colorScale=d3.scaleLinear().domain([0,data.length-1]).range(['#10b981','#8b5cf6']);
svg.append('text').attr('x',width/2).attr('y',25).attr('text-anchor','middle').style('font-size','20px').style('font-weight','bold').style('fill','#1e293b').text('📊 Monthly Crop Yield Trends');
svg.selectAll('rect').data(data).join('rect')
  .attr('x',d=>x(d.month)).attr('y',height-margin.bottom).attr('width',x.bandwidth()).attr('height',0)
  .attr('fill',(d,i)=>colorScale(i)).attr('rx',8)
  .transition().duration(1000).delay((d,i)=>i*100)
  .attr('y',d=>y(d.value)).attr('height',d=>height-margin.bottom-y(d.value));
svg.selectAll('text.value').data(data).join('text').attr('class','value')
  .attr('x',d=>x(d.month)+x.bandwidth()/2).attr('y',d=>y(d.value)-10)
  .attr('text-anchor','middle').style('font-size','14px').style('font-weight','bold').style('fill','#1e293b')
  .style('opacity',0).text(d=>d.value).transition().duration(1000).delay((d,i)=>i*100).style('opacity',1);
svg.append('g').attr('transform',\`translate(0,\${height-margin.bottom})\`).call(d3.axisBottom(x)).style('font-size','12px');
svg.append('g').attr('transform',\`translate(\${margin.left},0)\`).call(d3.axisLeft(y)).style('font-size','12px');
</script></body></html>
\`\`\`

LENIS SMOOTH SCROLL + GSAP - Luxury scrolling experiences:
\`\`\`html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.jsdelivr.net/gh/studio-freight/lenis@1.0.29/bundled/lenis.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>
<style>
body{margin:0;font-family:system-ui;background:#0a0e27;color:white}
section{min-height:100vh;display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:bold;position:relative}
.hero{background:linear-gradient(135deg,#667eea,#764ba2)}
.stats{background:linear-gradient(135deg,#10b981,#059669)}
.insights{background:linear-gradient(135deg,#f59e0b,#d97706)}
.card{background:rgba(255,255,255,0.1);padding:60px;border-radius:30px;backdrop-filter:blur(10px);box-shadow:0 20px 60px rgba(0,0,0,0.3)}
</style></head><body>
<section class="hero"><div class="card">🌾 Farm Intelligence</div></section>
<section class="stats"><div class="card">📊 94% Efficiency Achieved</div></section>
<section class="insights"><div class="card">💡 Smart Recommendations</div></section>
<script>
const lenis=new Lenis({duration:1.2,easing:(t)=>Math.min(1,1.001-Math.pow(2,-10*t)),smooth:true});
function raf(time){lenis.raf(time);requestAnimationFrame(raf)}
requestAnimationFrame(raf);
gsap.registerPlugin(ScrollTrigger);
gsap.utils.toArray('.card').forEach((card,i)=>{
  gsap.from(card,{scrollTrigger:{trigger:card,start:'top 80%',end:'top 20%',scrub:1},scale:0.8,opacity:0,y:100});
});
</script></body></html>
\`\`\`

ANIMATED GRADIENT CARDS - Quick, beautiful announcements:
\`\`\`html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<style>
body{margin:0;font-family:system-ui;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:linear-gradient(135deg,#667eea,#764ba2,#f093fb);padding:50px;border-radius:25px;color:white;box-shadow:0 25px 50px rgba(0,0,0,0.5);max-width:600px;opacity:0;transform:scale(0.9)}
h1{margin:0 0 20px 0;font-size:42px}
p{font-size:20px;line-height:1.6;margin:0}
</style></head><body>
<div class="card">
  <h1>🎯 Key Insight Discovered</h1>
  <p>Optimal irrigation timing detected: Early morning watering increases yield by 18% while reducing water consumption by 22%. Implementing this schedule across all zones will maximize efficiency.</p>
</div>
<script>
gsap.to('.card',{opacity:1,scale:1,duration:1,ease:'elastic.out(1,0.75)'});
</script></body></html>
\`\`\`

HTML ARTIFACT BEST PRACTICES:

• ALWAYS load libraries from CDN (fast, cached, efficient)
• Minify inline styles and scripts for performance
• Use GSAP for smooth, professional animations (ease:'power3.out', 'elastic.out')
• Implement Three.js for 3D data visualizations (growth patterns, spatial relationships)
• Use D3.js for complex data-driven graphics (force layouts, hierarchies, networks)
• Add Lenis for buttery-smooth scroll experiences in multi-section artifacts
• Keep render times under 100ms by optimizing geometry/particle counts
• Use requestAnimationFrame for smooth 60fps animations
• Implement gradient backgrounds for visual depth: linear-gradient(135deg, ...)
• Add box-shadow for elevation: 0 20px 60px rgba(0,0,0,0.3)
• Use backdrop-filter:blur() for modern glass-morphism effects
• Make all experiences responsive with viewport-relative units

WHEN TO USE EACH LIBRARY:

• GSAP: Counters, dashboard animations, UI transitions, scroll effects
• Three.js: 3D crop visualizations, spatial data, growth simulations, terrain maps
• D3.js: Complex charts, network graphs, hierarchical data, force-directed layouts
• Lenis: Multi-section scrolling experiences, smooth page navigation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GOAL: HTML artifacts should be WORLD-CLASS, interactive experiences that
feel premium and engaging. They are a PRIMARY FOCUS of the user journey!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  // Add role-specific instructions
  let roleInstructions = "";
  
  switch (expert.role) {
    case "Soil Scientist":
      roleInstructions = `Focus on soil health, composition, testing methods, and fertilization recommendations.
Provide insights on soil types, pH levels, nutrient content, organic matter, and sustainable soil management practices.
When appropriate, explain how soil conditions impact crop growth and farm productivity.`;
      break;
    case "Crop Specialist":
      roleInstructions = `Focus on crop varieties, rotation strategies, planting techniques, and yield optimization.
Provide insights on seed selection, crop health, disease identification, and sustainable farming methods.
When appropriate, explain how different crop choices and techniques impact overall farm productivity.`;
      break;
    case "Irrigation Engineer":
      roleInstructions = `Focus on water management systems, irrigation scheduling, water conservation, and drainage solutions.
Provide insights on irrigation technologies, water quality, efficiency improvements, and sustainable water use.
When appropriate, explain how water management impacts crop health and farm sustainability.`;
      break;
    case "Pest Management":
      roleInstructions = `Focus on insect, disease, and weed control using integrated pest management techniques.
Provide insights on pest identification, prevention strategies, biological controls, and judicious use of pesticides.
When appropriate, explain how pest management impacts crop health, yield, and environmental sustainability.`;
      break;
    case "Meteorologist":
      roleInstructions = `Focus on weather patterns, climate impacts on agriculture, and seasonal forecasting.
Provide insights on temperature trends, precipitation patterns, extreme weather events, and climate adaptation strategies.
When appropriate, explain how weather conditions impact farming decisions and risk management.`;
      break;
    case "File Creator":
      roleInstructions = `You specialize in creating useful files based on the discussion (e.g., reports, plans, data summaries, code snippets). 
      When asked to create a file, respond ONLY with a JSON object containing the file details. 
      The JSON object MUST have the following structure:
      {
        "filename": "your_suggested_filename.ext",
        "filetype": "mime/type or descriptive type like 'text/plain', 'text/csv', 'application/json', etc.",
        "content": "The full content of the file goes here as a string. Ensure proper escaping if the content itself is JSON or contains special characters."
      }
      Do NOT include any other text, explanation, or formatting outside of this JSON object in your response.
      `;
      break;
    case "Research Analyst":
      roleInstructions = `Focus on researching topics using external tools, summarizing findings, and providing citations.`;
      break;
    case "Imagery Specialist":
      roleInstructions = `Focus on analyzing satellite, drone, or field imagery to provide visual insights and interpretations. If images are provided, describe what you see and its relevance.`;
      break;
    case "Moderator":
      roleInstructions = `Facilitate the discussion, summarize key points, ensure all experts contribute, and manage conversation flow. 
      When asked who should speak next, analyze the last few messages and the overall goal. Respond ONLY with the role name of the expert who should speak next (e.g., 'Crop Specialist'). Do not add any other text. If unsure, suggest 'RoundRobin'.`;
      break;
    default:
      roleInstructions = `Provide insights based on your general agricultural knowledge.`;
  }

  return basePrompt + interactionPrompt + roleInstructions;
}

// Function to call OpenRouter API
export async function callOpenRouterAPI(messages: AIMessage[], model: string): Promise<AIModelResponse> {
  console.log(`[DEBUG] Entering callOpenRouterAPI for model: ${model}`);
  try {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) {
      console.error("[DEBUG] OpenRouter API key not provided");
      throw new Error("OpenRouter API key not provided");
    }
    
    console.log(`[DEBUG] Calling OpenRouter fetch: https://openrouter.ai/api/v1/chat/completions, Model: ${model}`);
    
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openRouterKey}`,
        "HTTP-Referer": "https://farm-friend-roundtable.replit.app", // Replace with your actual referer if different
        "X-Title": "Farm Friend Roundtable" // Replace with your actual title if different
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 8192,
      }),
    });
    
    console.log(`[DEBUG] OpenRouter fetch completed. Status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[DEBUG] OpenRouter API Error Response Text: ${errorText}`);
      throw new Error(`OpenRouter API Error (${response.status}): ${errorText}`);
    }
    
    console.log("[DEBUG] OpenRouter response OK. Parsing JSON...");
    const data = await response.json();
    console.log("[DEBUG] OpenRouter JSON parsed successfully.");
    
    // === Add check for top-level error object even if status was 200 ===
    if (data && data.error) {
        console.error(`[DEBUG] OpenRouter returned error object despite 200 OK:`, JSON.stringify(data.error));
        // Construct a user-friendly error message if possible
        const errorMsg = data.error.message || JSON.stringify(data.error);
        throw new Error(`OpenRouter Provider Error: ${errorMsg}`);
    }
    // ==================================================================

    // Add proper error handling for missing data
    if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0] || !data.choices[0].message) {
      console.error("[DEBUG] Invalid/Incomplete response structure from OpenRouter API:", JSON.stringify(data));
      throw new Error("Invalid response format from OpenRouter API");
    }
    
    console.log("[DEBUG] OpenRouter response structure validated. Returning message.");
    return {
      message: data.choices[0].message
    };
  } catch (error: unknown) {
    console.error("[DEBUG] Error caught within callOpenRouterAPI:", error);
    // Properly handle the unknown error type
    if (error instanceof Error) {
      throw error; // Re-throw the original error
    } else {
      throw new Error(`Unknown error in callOpenRouterAPI: ${String(error)}`);
    }
  }
}

// Function to call Perplexity API for web search
export async function callPerplexityAPI(query: string): Promise<AIModelResponse> {
  try {
    const perplexityKey = process.env.PERPLEXITY_API_KEY;
    if (!perplexityKey) {
      throw new Error("Perplexity API key not provided");
    }
    
    console.log("Calling Perplexity API for research query");
    
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${perplexityKey}`
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content: "You are a Research Analyst specializing in agriculture. Provide concise, accurate information with relevant citations."
          },
          {
            role: "user",
            content: query
          }
        ],
        temperature: 0.2,
        max_tokens: 1024,
        stream: false
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Perplexity API Error (${response.status}): ${errorText}`);
    }
    
    const data = await response.json();
    
    // Add proper error handling for missing data
    if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      console.error("Invalid response from Perplexity API:", JSON.stringify(data));
      throw new Error("Invalid response format from Perplexity API");
    }
    
    if (!data.choices[0] || !data.choices[0].message) {
      console.error("Missing message in Perplexity API response:", JSON.stringify(data.choices[0]));
      throw new Error("Missing message in Perplexity API response");
    }
    
    return {
      message: data.choices[0].message,
      citations: data.citations || []
    };
  } catch (error: unknown) {
    console.error("Error calling Perplexity API:", error);
    // Properly handle the unknown error type
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error(`Unknown error: ${String(error)}`);
    }
  }
}

// Helper function to safely map DB roles to AI API roles
const mapDbRoleToApiRole = (dbRole: string): AIMessage['role'] => {
  if (dbRole === 'user') return 'user';
  if (dbRole === 'assistant') return 'assistant';
  if (dbRole === 'system') return 'system'; // Explicitly handle system role
  // Fallback for unexpected roles, maybe log a warning
  console.warn(`Mapping unknown DB role "${dbRole}" to "assistant" for AI API.`);
  return 'assistant'; 
};

// Helper function to read and truncate file content
async function readFileContent(file: File, maxLength = 2000): Promise<string | null> {
    // Basic check for potentially text-based types
    const isTextBased = file.fileType.startsWith('text/') || 
                       ['csv', 'json', 'javascript', 'typescript', 'python', 'markdown'].some(ext => file.fileType.includes(ext));

    if (!isTextBased) {
        return `[Content of non-text file (${file.fileType}) is not available in this context]`;
    }

    try {
        // Construct absolute path from the relative URL stored
        const relativePath = file.fileUrl.startsWith('/') ? file.fileUrl.substring(1) : file.fileUrl;
        const filePath = path.join(process.cwd(), relativePath); 

        if (!fs.existsSync(filePath)) {
             console.error(`readFileContent: File not found at path: ${filePath} (derived from ${file.fileUrl})`);
             return `[File ${file.filename} not found on server]`;
        }

        const content = await fs.promises.readFile(filePath, 'utf8');
        if (content.length > maxLength) {
            return content.substring(0, maxLength) + '\n... [Content Truncated] ...';
        }
        return content;
    } catch (error) {
        console.error(`readFileContent: Error reading file ${file.filename}:`, error);
        return `[Error reading content of file ${file.filename}]`;
    }
}

// Function to generate response for a single expert
// Export this function so the orchestrator can use it
export async function getExpertResponse(
  expert: Expert, 
  history: Message[], 
  referenceMessageContent: string, 
  files: File[],
  availableRoles: string[] 
): Promise<InsertMessage> { 
  console.log(`Generating response for expert: ${expert.name} (${expert.role})`);
  const systemPrompt = generateSystemPrompt(expert, availableRoles); 
  
  // 1. Initialize messages array with system prompt
  const messages: AIMessage[] = [
    { role: "system", content: systemPrompt }
  ];

  // 2. Add File Context (if any) as a system message
  if (files.length > 0) {
     let fileContextString = "\n\n--- Attached Files Context ---\n";
     for (const file of files) {
         const contentSnippet = await readFileContent(file); // Read content
         fileContextString += `\nFile Name: ${file.filename} (${file.fileType})\n`;
         if (contentSnippet) {
              fileContextString += `Content Snippet:\n\`\`\`\n${contentSnippet}\n\`\`\`\n`;
         }
     }
     fileContextString += "\n--- End Attached Files Context ---\n";
     messages.push({ 
         role: "system", 
         content: fileContextString 
     });
  }

  // 3. Add relevant history messages
   messages.push(...history.map(msg => ({
      role: mapDbRoleToApiRole(msg.role),
      content: msg.content
   })).slice(-15)); // Limit history length to avoid excessive context

   // 4. Add the latest reference message last
   messages.push({ role: "user", content: referenceMessageContent });

   console.log(`[DEBUG] Sending ${messages.length} messages to LLM for ${expert.role}.`);
   // Optional: Log the full message structure for detailed debugging
   // console.log("[DEBUG] Messages:", JSON.stringify(messages, null, 2)); 

  try {
    let response: AIModelResponse;
    
    // Special handling for Research Analyst (Perplexity)
    if (expert.role === "Research Analyst") {
      // Perplexity might work better with just the query + file context?
      // Let's try sending only system, file context, and reference message
      const perplexityMessages = messages.filter(m => m.role === 'system' || m.role === 'user');
      // Ensure the last message is the user query
      if (perplexityMessages[perplexityMessages.length - 1]?.role !== 'user') {
           perplexityMessages.push({ role: "user", content: referenceMessageContent });
      }
      console.log(`[DEBUG] Sending ${perplexityMessages.length} messages specifically to Perplexity.`);
      response = await callPerplexityAPI(referenceMessageContent); // Perplexity API call structure might need only the query
      // TODO: Re-evaluate if perplexity call should use messages array instead
    } 
    // Special handling for File Creator (JSON response expected)
    else if (expert.role === "File Creator") {
       response = await callOpenRouterAPI(messages, expert.model);
       
       try {
         const fileData = JSON.parse(response.message.content);
         
         // Validate structure
         if (!fileData.filename || !fileData.filetype || !fileData.content) {
           throw new Error("Invalid JSON structure from File Creator");
         }
         
         // Create file (similar logic to original processUserMessage)
         const uploadsDir = path.join(process.cwd(), "uploads");
         if (!fs.existsSync(uploadsDir)) {
           fs.mkdirSync(uploadsDir);
         }
         const uniqueFilename = `${randomBytes(8).toString("hex")}-${fileData.filename}`;
         const filePath = path.join(uploadsDir, uniqueFilename);
         fs.writeFileSync(filePath, fileData.content);
         const fileUrl = `/uploads/${uniqueFilename}`;

         const newFile: InsertFile = {
            conversationId: expert.conversationId,
            filename: fileData.filename,
            fileUrl: fileUrl,
            fileType: fileData.filetype,
            uploadedBy: `Expert: ${expert.name}`, // Mark as uploaded by expert
         };
         await storage.createFile(newFile);
         
         // Adjust response message to confirm file creation
         response.message.content = `Created file: ${fileData.filename}`;

       } catch (jsonError) {
          console.error("File Creator error processing JSON:", jsonError);
          // Fallback to a normal text response if JSON is invalid or file saving fails
          response.message.content = "(File Creator Error: Could not process request to create file. Please ensure the request is clear and try again.)";
       }
    }
    // Default handling for other experts (OpenRouter)
    else {
      response = await callOpenRouterAPI(messages, expert.model);
    }
    
    // Extract artifacts from response
    const { artifacts, cleanContent } = extractArtifacts(response.message.content);
    
    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: cleanContent,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      artifacts: artifacts
    };

  } catch (error) {
    console.error(`Error getting response from expert ${expert.name}:`, error);
    // Return an error message formatted for storage
    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: `(Error generating response for ${expert.name}: ${error instanceof Error ? error.message : String(error)})`,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      // Consider adding an 'isError' flag if needed for UI
    };
  }
}

// OLD function - keep for reference or until fully deprecated
// Function to process user message and get expert responses (PARALLEL)
/*
export async function processUserMessage(
  userId: number,
  conversationId: number, 
  userMessage: string
): Promise<InsertMessage[]> {
// ... existing parallel processing logic ...
}
*/

// Function to generate insights (Re-enabled)
export async function generateInsights(conversationId: number, broadcastFn?: (convId: number, data: any) => void): Promise<void> {
  try {
    const messages = await storage.getConversationMessages(conversationId);
    if (messages.length < 3) return; // Not enough messages for insights
    
    // Base insights on a larger portion of the conversation
    const historyText = messages
      .slice(-20) // Use last 20 messages
      .map(m => `${m.expertName || m.role}: ${m.content}`) // Add role/name
      .join("\n");
    
    const insightPrompt = `
    Based on the following agricultural conversation transcript, identify 1-3 key insights, recommendations, or unresolved questions. Be concise.
    
    Transcript:
    ${historyText}
    
    Format your response STRICTLY as a JSON object with this structure:
    {
      "title": "Brief overall topic",
      "points": ["Insight/Recommendation 1", "Insight/Recommendation 2", "Insight/Recommendation 3"]
    }
    Only output the JSON object.
    `;
    
    const response = await callOpenRouterAPI([
      { role: "system", content: "You extract key insights from agricultural conversations. Respond only with the requested JSON format." },
      { role: "user", content: insightPrompt }
      // Use a capable model for summarization/extraction
      // Using Mixtral Instruct as a generally available good option
    ], "mistralai/mixtral-8x7b-instruct"); 
    
    try {
      const insightData = JSON.parse(response.message.content);
      
      if (insightData.title && Array.isArray(insightData.points) && insightData.points.length > 0) {
        // Store insight using the existing create function
        console.log(`Storing insights for conversation ${conversationId}:`, insightData);
        await storage.createInsight({ 
          conversationId,
          title: insightData.title,
          points: insightData.points
        });
        // Broadcast the new insights via WebSocket
        if (broadcastFn) {
          broadcastFn(conversationId, { type: "insights" });
        }
      } else {
         console.warn(`generateInsights: Received invalid JSON structure for ${conversationId}`, insightData);
      }
    } catch (e) {
      console.error(`generateInsights: Error parsing insights JSON for ${conversationId}:`, e, "\nRaw Response:", response.message.content);
    }
  } catch (error) {
    console.error(`generateInsights: Error generating insights for ${conversationId}:`, error);
  }
}

// New function to ask the Moderator who should speak next
export async function getModeratorNextSpeakerSuggestion(
  moderatorExpert: Expert,
  history: Message[],
  availableRoles: string[]
): Promise<string | null> {
    if (moderatorExpert.role !== 'Moderator') {
        console.warn("Attempted to get speaker suggestion from non-moderator expert.");
        return null;
    }
    console.log("Asking Moderator for next speaker suggestion...");
    const moderatorSystemPrompt = generateSystemPrompt(moderatorExpert, availableRoles);
    const queryPrompt = `Based on the recent conversation history, which expert should speak next to best advance the discussion towards resolution or new insights? The available expert roles are: [${availableRoles.join(', ')}]. Respond only with the role name or 'RoundRobin'.`;

    const messages: AIMessage[] = [
        { role: "system", content: moderatorSystemPrompt },
        ...history.slice(-6).map(msg => ({ // Limit history for this specific query
             role: mapDbRoleToApiRole(msg.role),
             content: msg.content
        })),
        { role: "user", content: queryPrompt }
    ];

    try {
        // Use a cheaper/faster model for this focused task if desired
        const response = await callOpenRouterAPI(messages, moderatorExpert.model || 'mistralai/mistral-7b-instruct'); 
        const suggestedRole = response.message.content.trim().replace(/\.$/, ''); // Clean up response
        
        // Validate if the suggestion is one of the available roles or RoundRobin
        if (availableRoles.includes(suggestedRole) || suggestedRole === 'RoundRobin') {
             console.log(`Moderator suggested next speaker: ${suggestedRole}`);
            return suggestedRole;
        } else {
            console.warn(`Moderator suggested an invalid role: '${suggestedRole}'. Falling back.`);
            return null; // Fallback if suggestion is invalid
        }
    } catch (error) {
        console.error("Error querying Moderator for next speaker:", error);
        return null; // Fallback on error
    }
}
