import { useEffect, useRef } from "react";
import * as THREE from "three";
import { Expert } from "@shared/schema";
import { initThreeScene, createTable, createExpertAvatar } from "@/lib/three-utils";

interface RoundtableVisualizationProps {
  experts: Expert[];
  showExpertSelector: boolean;
}

export default function RoundtableVisualization({ 
  experts,
  showExpertSelector
}: RoundtableVisualizationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    table: THREE.Mesh;
    expertAvatars: THREE.Mesh[];
    animationFrameId?: number;
  } | null>(null);
  
  // Initialize Three.js scene
  useEffect(() => {
    if (!containerRef.current) return;
    
    const { scene, camera, renderer, table } = initThreeScene(containerRef.current);
    
    sceneRef.current = {
      scene,
      camera,
      renderer,
      table,
      expertAvatars: []
    };
    
    // Set up animation loop
    function animate() {
      if (!sceneRef.current) return;
      
      const { scene, camera, renderer, table, expertAvatars } = sceneRef.current;
      
      // Add subtle rotation to the table
      table.rotation.y += 0.001;
      
      // Add subtle bob animation to experts
      expertAvatars.forEach((expert, index) => {
        expert.position.y = 1 + Math.sin(Date.now() * 0.001 + index) * 0.05;
      });
      
      renderer.render(scene, camera);
      sceneRef.current.animationFrameId = requestAnimationFrame(animate);
    }
    
    animate();
    
    // Handle window resize
    const handleResize = () => {
      if (!containerRef.current || !sceneRef.current) return;
      
      const { camera, renderer } = sceneRef.current;
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    
    window.addEventListener("resize", handleResize);
    
    // Cleanup
    return () => {
      window.removeEventListener("resize", handleResize);
      
      if (sceneRef.current && sceneRef.current.animationFrameId) {
        cancelAnimationFrame(sceneRef.current.animationFrameId);
      }
      
      if (sceneRef.current && sceneRef.current.renderer) {
        sceneRef.current.renderer.dispose();
      }
    };
  }, []);
  
  // Update experts in scene when they change
  useEffect(() => {
    if (!sceneRef.current) return;
    
    const { scene, expertAvatars } = sceneRef.current;
    
    // Remove existing expert avatars
    expertAvatars.forEach(avatar => {
      scene.remove(avatar);
    });
    
    // Clear array
    expertAvatars.length = 0;
    
    // Add new expert avatars
    const count = experts.length;
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const radius = 3.5;
        
        const x = Math.sin(angle) * radius;
        const z = Math.cos(angle) * radius;
        
        const expert = createExpertAvatar(i, experts[i].role);
        expert.position.set(x, 1, z);
        
        scene.add(expert);
        expertAvatars.push(expert);
      }
    }
  }, [experts]);
  
  return (
    <div className="w-full md:w-1/2 h-full relative bg-neutral-100 border-r border-neutral-300">
      <div ref={containerRef} className="absolute inset-0" />
      
      {/* Expert info overlays */}
      {experts.length > 0 && !showExpertSelector && (
        <div className="absolute inset-0 pointer-events-none">
          {experts.map((expert, index) => {
            const angle = (index / experts.length) * Math.PI * 2;
            const radius = 3.5;
            
            // Calculate position as percentage from center
            const centerX = 50;
            const centerY = 50;
            const x = centerX + Math.sin(angle) * radius * 12; // Scale for percentage
            const y = centerY + Math.cos(angle) * radius * 10; // Less vertical scaling
            
            return (
              <div
                key={expert.id}
                className="absolute bg-white bg-opacity-70 px-1.5 py-0.5 rounded text-xs font-medium shadow-sm"
                style={{
                  left: `${x}%`,
                  top: `${y}%`,
                  transform: 'translate(-50%, -120%)'
                }}
              >
                {expert.name}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
