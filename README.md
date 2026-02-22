RogueCord

RogueCord is a free and open-source, self-hosted real-time communication platform designed as a modern alternative to centralized chat systems.

It provides unlimited users, secure end-to-end encryption, and built-in screen sharing — without artificial restrictions, subscription tiers, or vendor lock-in.

✨ Features

🔓 Free & Open Source

🖥 Self-Hosted Infrastructure

👥 Unlimited Users / No Slot Limits

🔐 End-to-End Encrypted Messaging

🎥 Real-Time Screen Sharing

💬 Text & Voice Channels

⚡ High-Performance WebRTC Media Stack

🌍 Cross-Platform (Web, Desktop)

🚀 Philosophy

RogueCord exists to provide:

Full infrastructure sovereignty

No usage caps

No monetization traps

No data harvesting

Transparent security model

You own your server.
You control your data.
You define your limits.

🏗 Architecture Overview

RogueCord is designed around:

WebSocket-based real-time messaging

WebRTC media transport for voice/video/screen share

End-to-end encryption for private communications

Horizontal scalability for high concurrency environments

Recommended deployment:

Reverse proxy (e.g. Nginx / Caddy)

Dedicated TURN server for NAT traversal

Linux-based host (recommended)

🔐 Security

RogueCord implements:

End-to-End Encryption (E2EE) for private messages

Secure WebRTC media channels (DTLS-SRTP)

Encrypted signaling transport (WSS / TLS)

Zero telemetry

No third-party data processors

Security audits and reproducible builds are planned.

📦 Installation (Example)
git clone https://github.com/your-org/roguecord.git
cd roguecord
docker compose up -d

Then open:

https://your-domain.com

Full deployment documentation: /docs

📊 Scalability

RogueCord has:

No artificial user limits

No paid “slot” tiers

No usage-based throttling

Scalability depends solely on your infrastructure resources.

🛠 Development

Requirements:

Node.js (LTS recommended)

Docker (optional)

PostgreSQL

Redis

Run in development mode:

npm install
npm run dev
📄 License

RogueCord is licensed under:

[INSERT LICENSE HERE]

If you want to ensure improvements remain open and prevent proprietary SaaS forks, consider using a strong copyleft license such as AGPLv3.

🤝 Contributing

Contributions are welcome.

Fork the repository

Create a feature branch

Submit a pull request

All contributions must follow the project’s coding and security standards.
