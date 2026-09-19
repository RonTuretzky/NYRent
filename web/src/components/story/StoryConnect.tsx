const LINKS = [
  { title: "RentSafe", label: "Explore the market", display: "rentsafe.nyc", url: "https://rentsafe.nyc/", image: "rentsafe" },
  { title: "Decentral Park", label: "Our community", display: "decentralpark.nyc", url: "https://decentralpark.nyc/", image: "decentral-park" },
  { title: "Ron Turetzky", label: "Presenter", display: "@RonTuretzky", url: "https://x.com/RonTuretzky", image: "ron-turetzky" },
  { title: "Shaurya", label: "Presenter", display: "@shaudub", url: "https://x.com/shaudub", image: "shaudub" },
];

export function StoryConnect() {
  return <>
    <p className="story-copy">Scan to explore RentSafe, find our community, or connect with your presenters.</p>
    <div className="story-connect-grid" aria-label="Scan or open our links">
      {LINKS.map(link => <a key={link.image} className="story-connect-card" href={link.url} target="_blank" rel="noreferrer" aria-label={`Open ${link.title}: ${link.display}`}>
        <span className="story-connect-label">{link.label}</span>
        <h2>{link.title}</h2>
        <img src={`/story/qr/${link.image}.svg`} alt={`QR code for ${link.url}`} width="296" height="296" />
        <span className="story-connect-address">{link.display}<span aria-hidden="true"> ↗</span></span>
      </a>)}
    </div>
  </>;
}
