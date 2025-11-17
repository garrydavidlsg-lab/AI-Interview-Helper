import React, { useRef, useEffect } from 'react';

interface AudioVisualizerProps {
  analyserNode: AnalyserNode | null;
  isListening: boolean;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ analyserNode, isListening }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameId = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyserNode) return;

    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;

    // Set canvas dimensions for high-DPI screens
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvasCtx.scale(dpr, dpr);
    
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationFrameId.current = requestAnimationFrame(draw);
      
      analyserNode.getByteFrequencyData(dataArray);

      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const radius = 40; // Base radius, slightly larger than the button
      const bars = 60; // Number of bars to draw
      const barWidth = 2;
      
      canvasCtx.lineWidth = barWidth;
      canvasCtx.lineCap = 'round';

      const gradient = canvasCtx.createLinearGradient(0, 0, rect.width, rect.height);
      gradient.addColorStop(0, '#818cf8'); // Indigo-400
      gradient.addColorStop(1, '#4f46e5'); // Indigo-600


      for (let i = 0; i < bars; i++) {
        const angle = (i / bars) * 2 * Math.PI;
        
        // Use a subset of the frequency data
        const dataIndex = Math.floor((i / bars) * (bufferLength * 0.7));
        const barHeight = Math.pow(dataArray[dataIndex] / 255, 2.5) * 40;

        const startX = centerX + Math.cos(angle) * radius;
        const startY = centerY + Math.sin(angle) * radius;
        const endX = centerX + Math.cos(angle) * (radius + barHeight);
        const endY = centerY + Math.sin(angle) * (radius + barHeight);

        canvasCtx.beginPath();
        canvasCtx.strokeStyle = gradient;
        canvasCtx.moveTo(startX, startY);
        canvasCtx.lineTo(endX, endY);
        canvasCtx.stroke();
      }
    };

    if (isListening) {
      draw();
    } else {
      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(animationFrameId.current);
    }

    return () => {
      cancelAnimationFrame(animationFrameId.current);
    };
  }, [analyserNode, isListening]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />;
};

export default AudioVisualizer;
