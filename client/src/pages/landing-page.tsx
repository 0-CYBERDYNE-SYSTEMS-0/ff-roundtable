import { Link } from "wouter";
import { ArrowDown, ArrowRight } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import "../styles/public-pages.css";

const features = [
  {
    number: "01",
    title: "A table full of farm specialists",
    body: "Bring soil science, crop planning, livestock, irrigation and more into one conversation. Your question goes to a panel of AI farm experts, each with a different point of view.",
  },
  {
    number: "02",
    title: "Answers you can put to work",
    body: "Get thoughtful, practical responses with useful tables and charts—not just a paragraph of suggestions. Compare options, weigh trade-offs and leave with a clearer next step.",
  },
  {
    number: "03",
    title: "Your farm conversations, kept",
    body: "Save sessions and return when the season changes. Keep research, plans and follow-up questions together instead of losing good advice in a long chat history.",
  },
  {
    number: "04",
    title: "Made for real farm decisions",
    body: "Built around the questions that come with running a farm: what to plant, when to act, how to manage resources and what to consider before the next move.",
  },
];

export default function LandingPage() {
  const { user, isLoading } = useAuth();
  const registerHref = isLoading ? "/auth" : user ? "/" : "/sign-up";
  return (
    <main className="ff-public">
      <section className="ff-hero" aria-labelledby="landing-title">
        <nav className="ff-nav" aria-label="Main navigation">
          <Link href="/" className="ff-brand">
            <img src="/logo.jpeg" alt="" />
            <span>Farm Friend Roundtable</span>
          </Link>
          <div className="ff-nav-links">
            <a className="ff-nav-pricing" href="#how-it-helps">How it helps</a>
            <Link className="ff-nav-pricing" href="/pricing">Plans</Link>
            <Link href="/sign-in">Sign in</Link>
            <Link className="ff-button ff-button-primary" href={registerHref}>Get started <ArrowRight size={15} aria-hidden="true" /></Link>
          </div>
        </nav>
        <div className="ff-hero-content">
          <div className="ff-glass">
            <div className="ff-eyebrow">Good questions grow better farms</div>
            <h1 id="landing-title">A little more wisdom at the <em>table.</em></h1>
            <p className="ff-hero-copy">Bring your farm question to a roundtable of AI experts. Hear different perspectives, find practical answers, and make your next decision with more confidence.</p>
            <div className="ff-hero-actions">
              <Link className="ff-button ff-button-primary" href={registerHref}>Get started with Pro <ArrowRight size={16} aria-hidden="true" /></Link>
              <a className="ff-button ff-button-quiet" href="#how-it-helps">See how it works <ArrowDown size={15} aria-hidden="true" /></a>
            </div>
            <div className="ff-proof"><span className="ff-proof-mark" aria-hidden="true">8</span><span>Up to eight farm experts with Pro</span></div>
          </div>
        </div>
        <div className="ff-scroll-note">Grounded in the work of the land</div>
      </section>

      <section className="ff-section" id="how-it-helps" aria-labelledby="how-title">
        <div className="ff-section-inner">
          <div className="ff-section-kicker">Many minds. One farm question.</div>
          <h2 id="how-title">The kind of advice that sees the whole field.</h2>
          <p className="ff-section-lead">Farm decisions rarely fit in one specialty. Farm Friend brings a panel of AI farm experts together to discuss your question from several angles, so the answer has more context than a single opinion.</p>
          <div className="ff-feature-grid">
            {features.map((feature) => (
              <article className="ff-feature" key={feature.number}>
                <span className="ff-feature-number">{feature.number}</span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
          <div className="ff-pricing-band">
            <div><strong>Bring more expertise to your next farm decision.</strong><span>Explore Pro and Enterprise to find the right plan for your operation.</span></div>
            <Link className="ff-button ff-button-dark" href="/pricing">Compare plans <ArrowRight size={15} aria-hidden="true" /></Link>
          </div>
        </div>
      </section>
      <footer className="ff-footer">
        <div className="ff-footer-inner">
          <span>Farm Friend Roundtable · A better-informed next step.</span>
          <span><Link href="/pricing">Plans</Link> · <Link href="/sign-in">Sign in</Link></span>
        </div>
      </footer>
    </main>
  );
}
