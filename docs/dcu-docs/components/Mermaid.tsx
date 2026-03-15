'use client';
import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

export default function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      securityLevel: 'strict',
      fontFamily: 'inherit'
    });
    
    if (ref.current && !rendered) {
      mermaid.render('mermaid-svg-' + Math.random().toString(36).substring(7), chart).then(({ svg }) => {
        if (ref.current) {
          ref.current.innerHTML = svg;
          setRendered(true);
        }
      });
    }
  }, [chart, rendered]);

  return <div ref={ref} className="mermaid flex justify-center my-8 text-zinc-300" />;
}
