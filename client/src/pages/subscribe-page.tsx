import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft } from "lucide-react";
import PricingPlans from "@/components/billing/PricingPlans";
import "../styles/public-pages.css";

export default function SubscribePage() {
  const { user } = useAuth();
  return (
    <main className="ff-public ff-pricing-page">
      <header className="ff-pricing-header">
        <div className="ff-pricing-header-inner">
          <Link href="/" className="ff-pricing-brand"><img src="/logo.jpeg" alt="" /><span>Farm Friend Roundtable</span></Link>
          {user ? <Link className="ff-button ff-button-dark" href="/">Go to your farm <ArrowLeft size={14} aria-hidden="true" /></Link> : <Link className="ff-button ff-button-dark" href="/sign-in">Sign in</Link>}
        </div>
      </header>
      <PricingPlans />
      <footer className="ff-footer">
        <div className="ff-footer-inner"><Link href="/">Back to Farm Friend</Link><span>Practical perspective for the work ahead.</span></div>
      </footer>
    </main>
  );
}
