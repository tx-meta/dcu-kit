import Link from 'next/link';
import { ChevronRight, Code2, ShieldCheck, Cpu } from 'lucide-react';

export default function HomePage() {
  return (
    <main className="flex flex-col items-center min-h-screen pt-32 pb-24 px-6 relative bg-fd-background text-fd-foreground font-sans selection:bg-fd-accent/20">
      
      <div className="z-10 max-w-5xl w-full flex flex-col items-center">
        {/* Minimalist Heading Section */}
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-light tracking-tight text-fd-foreground mb-6 text-center leading-tight">
          The <span className="font-semibold text-fd-primary">DCU Toolkit</span> SDK
        </h1>
        
        <p className="text-lg md:text-xl text-fd-muted-foreground max-w-3xl mb-12 text-center leading-relaxed">
          The official middleware layer for Decentralized Credit Union smart contracts. 
          Built for scale and absolute type-safety on Cardano.
        </p>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-4 mb-24 w-full sm:w-auto">
          <Link 
            href="/docs" 
            className="inline-flex items-center justify-center rounded-md bg-fd-primary text-fd-primary-foreground px-8 py-3 text-sm font-medium transition-all hover:bg-fd-primary/90 active:scale-[0.98]"
          >
            Read the Documentation
            <ChevronRight className="ml-1 h-4 w-4" />
          </Link>
          <a
            href="https://github.com/tx-meta/dcu-kit"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center rounded-md border border-fd-border bg-transparent px-8 py-3 text-sm font-medium text-fd-foreground transition-colors hover:border-fd-primary hover:bg-fd-accent"
          >
            View Repository
          </a>
        </div>

        {/* Elegant Feature Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-left w-full border-t border-fd-border pt-16">
          <div className="group flex flex-col items-start text-fd-muted-foreground transition-colors hover:text-fd-foreground">
            <ShieldCheck className="h-5 w-5 mb-4 text-fd-muted-foreground group-hover:text-fd-primary transition-colors" />
            <h3 className="text-base font-medium text-fd-foreground mb-2">Immutable Type-Safety</h3>
            <p className="text-sm leading-relaxed">
              Complete TypeScript coverage from configuration builders down to the complex transaction payloads and CIP-68 endpoints.
            </p>
          </div>
          
          <div className="group flex flex-col items-start text-fd-muted-foreground transition-colors hover:text-fd-foreground">
            <Cpu className="h-5 w-5 mb-4 text-fd-muted-foreground group-hover:text-fd-primary transition-colors" />
            <h3 className="text-base font-medium text-fd-foreground mb-2">Effect Architecture</h3>
            <p className="text-sm leading-relaxed">
              Handle errors gracefully and compose robust concurrent programs using the industry-leading Effect TS framework.
            </p>
          </div>

          <div className="group flex flex-col items-start text-fd-muted-foreground transition-colors hover:text-fd-foreground">
            <Code2 className="h-5 w-5 mb-4 text-fd-muted-foreground group-hover:text-fd-primary transition-colors" />
            <h3 className="text-base font-medium text-fd-foreground mb-2">Lucid Evolution</h3>
            <p className="text-sm leading-relaxed">
              Seamless low-level integration to efficiently construct, validate, and sign complex Plutus V3 smart contract interactions.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
