import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Check,
  FileSearch,
  FileUp,
  LockKeyhole,
  Map,
  Plane,
  RotateCcw,
  Route,
  ShieldCheck,
} from "lucide-react";
import styles from "./landing-page.module.css";

const journey = [
  {
    icon: FileUp,
    title: "Bring your logbook",
    copy: "Import ForeFlight, myFlightradar24, MyFlightbook, CrewLounge Pilotlog, or a compatible CSV.",
  },
  {
    icon: FileSearch,
    title: "See your flights on the map",
    copy: "Waypointer checks each uploaded flight, asks for help only when something needs attention, and adds ready flights to your map automatically.",
  },
  {
    icon: Map,
    title: "Explore your history",
    copy: "Move between your interactive map, route history, filters, and statistics.",
  },
] as const;

const previewFlights = [
  { date: "JUN 18", route: "SEA → SFO", detail: "2h 08m · A320" },
  { date: "MAY 04", route: "SFO → HNL", detail: "5h 31m · B789" },
  { date: "MAR 22", route: "HNL → KOA", detail: "0h 47m · C172" },
] as const;

function Brand() {
  return (
    <span className={styles.brand}>
      <span className={styles.brandMark}><Plane size={18} aria-hidden="true" /></span>
      Waypointer
    </span>
  );
}

function ProductPreview() {
  return (
    <div className={styles.productWindow} data-preview="synthetic">
      <div className={styles.windowBar}>
        <Brand />
        <span className={styles.syntheticBadge}>Synthetic preview</span>
      </div>
      <div className={styles.productBody}>
        <aside className={styles.previewSidebar} aria-label="Example flight statistics">
          <p className={styles.previewEyebrow}>All flight history</p>
          <h2>Across oceans and runways.</h2>
          <div className={styles.previewStats}>
            <div><strong>128</strong><span>Flights</span></div>
            <div><strong>186h</strong><span>Air time</span></div>
            <div><strong>42</strong><span>Airports</span></div>
            <div><strong>68k</strong><span>Miles</span></div>
          </div>
          <div className={styles.previewList}>
            {previewFlights.map((flight) => (
              <div key={flight.date + flight.route}>
                <span>{flight.date}</span>
                <p><strong>{flight.route}</strong><small>{flight.detail}</small></p>
              </div>
            ))}
          </div>
        </aside>
        <div className={styles.previewMap} aria-label="Synthetic route map preview">
          <div className={styles.mapGrid} />
          <span className={`${styles.routeLine} ${styles.routeOne}`} />
          <span className={`${styles.routeLine} ${styles.routeTwo}`} />
          <span className={`${styles.routeLine} ${styles.routeThree}`} />
          <span className={`${styles.airportDot} ${styles.seattle}`}><i />SEA</span>
          <span className={`${styles.airportDot} ${styles.sanFrancisco}`}><i />SFO</span>
          <span className={`${styles.airportDot} ${styles.honolulu}`}><i />HNL</span>
          <span className={`${styles.airportDot} ${styles.kona}`}><i />KOA</span>
          <div className={styles.mapLegend}><Route size={14} /> 3 routes shown</div>
        </div>
      </div>
    </div>
  );
}

function ImportPreview() {
  return (
    <div className={styles.importPreview} data-preview="synthetic">
      <div className={styles.importTop}>
        <div>
          <span className={styles.previewEyebrow}>Import progress</span>
          <strong>summer-logbook.csv</strong>
        </div>
        <span>12 rows found</span>
      </div>
      <div className={styles.progressTrack}><span /></div>
      <div className={styles.importRows}>
        <div><Check size={16} /><span>SEA → SFO</span><small>Ready</small></div>
        <div><RotateCcw size={16} /><span>SFO → HNL</span><small>Possible duplicate</small></div>
        <div><FileSearch size={16} /><span>HNL → —</span><small>Review airport</small></div>
      </div>
      <p>Resolved rows commit automatically. Only unresolved exceptions wait for review.</p>
    </div>
  );
}

export function LandingPage() {
  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#main-content">Skip to main content</a>
      <header className={styles.header}>
        <Link href="/" aria-label="Waypointer homepage"><Brand /></Link>
        <nav aria-label="Homepage navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <div className={styles.headerActions}>
          <Link className={styles.signInLink} href="/auth/sign-in">Sign in</Link>
          <Link className={styles.smallCta} href="/auth/register">Create account</Link>
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}><span /> Your flights, finally in one place</p>
            <h1 id="hero-title">Turn your flight logs into a map of everywhere you&apos;ve flown.</h1>
            <p className={styles.lede}>
              Import the logbooks you already have. Waypointer organizes your
              routes into an interactive personal map, searchable history, and
              useful travel statistics.
            </p>
            <div className={styles.heroActions}>
              <Link className={styles.primaryCta} href="/auth/register">
                Create your free account <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <Link className={styles.secondaryCta} href="/auth/sign-in">I already have an account</Link>
            </div>
            <p className={styles.ctaNote}><LockKeyhole size={15} /> Private by default. You decide what leaves your account.</p>
          </div>
          <ProductPreview />
        </section>

        <section className={styles.sourceStrip} aria-label="Supported import sources">
          <p>Start with the records you already keep</p>
          <div>
            <span>ForeFlight</span>
            <span>myFlightradar24</span>
            <span>MyFlightbook</span>
            <span>CrewLounge Pilotlog</span>
            <span>Generic CSV</span>
          </div>
          <small>CSV formats vary. Unresolved fields and rows stay available for review rather than being guessed.</small>
        </section>

        <section className={styles.journeySection} id="how-it-works" aria-labelledby="journey-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>From file to flight history</p>
            <h2 id="journey-title">A clear path from scattered records to one living map.</h2>
            <p>Resolved rows become part of your history automatically. Review appears only for unresolved exceptions.</p>
          </div>
          <ol className={styles.journeyGrid}>
            {journey.map(({ icon: Icon, title, copy }, index) => (
              <li key={title}>
                <span className={styles.stepNumber}>0{index + 1}</span>
                <span className={styles.stepIcon}><Icon size={21} aria-hidden="true" /></span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.featureSection} aria-labelledby="organize-title">
          <div className={styles.featureCopy}>
            <p className={styles.eyebrow}>Import with context</p>
            <h2 id="organize-title">Automation does the sorting. You keep the final say.</h2>
            <p>
              Airports are matched, rows are normalized, and exact duplicates
              are removed automatically. If a CSV column, airport, or possible
              duplicate cannot be resolved safely, Waypointer asks you to
              review only that exception.
            </p>
            <ul>
              <li><Check size={17} /> Source and import status stay visible</li>
              <li><Check size={17} /> Clean rows map and commit without a review stop</li>
              <li><Check size={17} /> Unresolved exceptions remain visible for correction</li>
            </ul>
          </div>
          <ImportPreview />
        </section>

        <section className={styles.insightsSection} aria-labelledby="insights-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>More than pins on a map</p>
            <h2 id="insights-title">See the shape of your travel history.</h2>
            <p>Filter routes, revisit individual flights, and understand the patterns behind the miles.</p>
          </div>
          <div className={styles.insightCards}>
            <article>
              <Map size={22} />
              <h3>Interactive routes</h3>
              <p>Explore airport activity and the routes connecting your personal network.</p>
              <div className={styles.miniRoute}><i /><span /><i /></div>
            </article>
            <article>
              <BarChart3 size={22} />
              <h3>History and statistics</h3>
              <p>Track flights, air time, distance, airports, aircraft, and changes over time.</p>
              <div className={styles.miniBars}><i /><i /><i /><i /><i /></div>
            </article>
            <article>
              <Route size={22} />
              <h3>Globe or flat map</h3>
              <p>Switch map views while keeping the same routes, filters, and airport focus.</p>
              <div className={styles.miniFlight}><span>3D</span><Plane size={15} /><span>2D</span></div>
            </article>
          </div>
        </section>

        <section className={styles.privacySection} id="privacy" aria-labelledby="privacy-title">
          <div className={styles.privacyIcon}><ShieldCheck size={30} /></div>
          <div>
            <p className={styles.eyebrow}>Designed for personal history</p>
            <h2 id="privacy-title">Private by default. Your history stays yours.</h2>
            <p>
              Your account and map are not public profiles. Your imported
              history stays inside your authenticated workspace and is not
              listed in a public directory.
            </p>
          </div>
          <ul>
            <li><LockKeyhole size={17} /><span><strong>Private first</strong>Your map starts visible only to you.</span></li>
            <li><ShieldCheck size={17} /><span><strong>Owner workspace</strong>Account controls stay behind authentication.</span></li>
            <li><FileSearch size={17} /><span><strong>Exception focused</strong>Only unresolved import rows require your attention.</span></li>
          </ul>
        </section>

        <section className={styles.finalCta} aria-labelledby="final-cta-title">
          <p className={styles.eyebrow}>Your history is already out there</p>
          <h2 id="final-cta-title">Bring it together in Waypointer.</h2>
          <p>Start with one logbook. Resolve exceptions only when needed. Watch your personal route network take shape.</p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryCta} href="/auth/register">
              Create your account <ArrowRight size={18} />
            </Link>
            <Link className={styles.secondaryCta} href="/auth/sign-in">Sign in</Link>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <Brand />
        <p>A private home for your personal flight history.</p>
        <div><Link href="/auth/sign-in">Sign in</Link><Link href="/auth/register">Create account</Link></div>
      </footer>
    </div>
  );
}
