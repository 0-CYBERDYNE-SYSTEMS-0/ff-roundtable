import { Link } from "wouter";
import { ArrowDown, ArrowRight } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import PricingPlans from "@/components/billing/PricingPlans";
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

const demoShots = [
  { file: "01-conversation-climate-planting", lg: [1440, 900], sm: [720, 450], text: "Ask a planting question; the roundtable answers with a sourced NOAA climate chart for Eugene, OR." },
  { file: "02-chart-eugene-tavg-daily-normals-heatmap", lg: [1224, 1244], sm: [720, 732], text: "NOAA 1991–2020 daily average-temperature normals for Eugene, OR (station USW00024221), shown as a calendar heatmap." },
  { file: "03-chart-eugene-daily-temperature-range", lg: [1224, 1244], sm: [720, 732], text: "Eugene's typical daily low, high, and average temperature across the year (NOAA 1991–2020 normals)." },
  { file: "04-chart-osu-region-2-planting-windows", lg: [1224, 1180], sm: [720, 694], text: "Planting windows for 11 vegetables from OSU Extension EM 9027, Region 2 guidance." },
  { file: "05-chart-eugene-monthly-climate-normals", lg: [1224, 1166], sm: [720, 686], text: "Eugene monthly temperature and precipitation normals, NOAA NCEI 1991–2020." },
  { file: "06-chart-daily-tmax-normals-ridgeline", lg: [1224, 1648], sm: [720, 969], text: "How daily high-temperature normals are distributed in each month in Eugene (NOAA 1991–2020)." },
  { file: "07-conversation-planting-calendar-ics", lg: [1440, 900], sm: [720, 450], text: "Turn OSU planting guidance into a downloadable calendar with review reminders." },
  { file: "08-artifacts-tab", lg: [1440, 966], sm: [720, 483], text: "Every chart and calendar from the session is saved in one Artifacts tab, with its sources attached." },
  { file: "09-insights-panel", lg: [1440, 900], sm: [720, 450], text: "Insights lists the public sources behind each answer, and what they can't tell you." },
] as const;

const demoSizes = "(max-width: 760px) calc(100vw - 40px), (max-width: 1024px) calc(50vw - 40px), 364px";

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
            <a className="ff-nav-pricing" href="#pricing">Plans</a>
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
              <Link className="ff-button ff-button-primary" href={registerHref}>Start free <ArrowRight size={16} aria-hidden="true" /></Link>
              <a className="ff-button ff-button-quiet" href="#how-it-helps">See how it works <ArrowDown size={15} aria-hidden="true" /></a>
            </div>
            <div className="ff-proof"><span className="ff-proof-mark" aria-hidden="true">3</span><span>Start with three experts, free</span></div>
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
        </div>
      </section>
      <section className="ff-section ff-demo" id="demo" aria-labelledby="demo-title">
        <div className="ff-section-inner">
          <h2 id="demo-title">Screenshots</h2>
          <div className="ff-demo-grid">
            {demoShots.map((shot) => (
              <figure className="ff-demo-item" key={shot.file}>
                <img
                  src={`/images/demo/${shot.file}-720.webp`}
                  srcSet={`/images/demo/${shot.file}-720.webp ${shot.sm[0]}w, /images/demo/${shot.file}-1440.webp ${shot.lg[0]}w`}
                  sizes={demoSizes}
                  width={shot.sm[0]}
                  height={shot.sm[1]}
                  loading="lazy"
                  decoding="async"
                  alt={shot.text}
                />
                <figcaption>{shot.text}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>
      <section id="pricing" className="ff-pricing-embed" aria-label="Farm Friend plans">
        <PricingPlans embedded />
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
