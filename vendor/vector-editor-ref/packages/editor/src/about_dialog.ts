/**
 * AboutDialog — modal showing application info and credits.
 */
// The editor reports its own version rather than relying on the host to inject
// one: a bug report that says "1.0.0-beta.1" is worth more than one that says
// "the latest", and an embedder should not have to wire a build-time global to
// get that. Read straight from the package manifest so the two can never drift.
import pkg from '../package.json' with { type: 'json' };

// The paper-boat mark, turned 45° with the rear facets filled solid.
// Centred and held at 88% of the tile so it never meets the rounded corner.
// Inlined so the editor stays self-contained; matches the app's public/logo.svg.
const MARK =
    '<g transform="translate(0.9666 0.9666) scale(1.00070)"><g transform="matrix(1,0,0,1,-10.22311782836914,66.52949523925781)"><g transform="matrix(1,0,0,1,-159.1393699645996,-157.09656524658203)"><path d="M 234.50772094726562 127.00498962402344 C 234.50772094726562 127.00498962402344 230.1516876220703 125.77210998535156 228.79788208007812 125.38894653320312 C 228.0972900390625 125.21049499511719 247.91107177734375 99.07450866699219 247.91107177734375 99.07450866699219 C 247.91021728515625 99.08277893066406 234.6810760498047 126.6944808959961 234.50772094726562 127.00498962402344 Z" fill="#f4f4f4" fill-opacity="1" stroke="none" /><path d="M 177.86109924316406 169.12449645996094 C 177.86109924316406 169.12449645996094 204.07357788085938 149.54776000976562 204.07357788085938 149.54776000976562 C 204.07545471191406 149.5542755126953 205.85861206054688 155.79544067382812 205.8878173828125 155.8976287841797 C 205.74713134765625 155.90219116210938 177.86111450195312 169.12448120117188 177.86109924316406 169.12449645996094 Z" fill="#f4f4f4" fill-opacity="1" stroke="none" /></g><g transform="matrix(1.009840965270996,-1.009840965270996,1.0098412036895752,1.0098412036895752,84.43734741210938,-30.16236114501953)"><path d="M 18.738998 -7.861019 C 20.230133 -9.813702 18.247871 -12.500114 15.946075 -11.648037 C 15.946075 -11.648037 -4.670685 -4.387615 -4.670685 -4.387615 C -4.670685 -4.387615 -18.744904 1.2245064 -18.744904 1.2245064 C -18.744904 1.2245064 3.4666672 11.648037 3.4666672 11.648037 C 3.8039474 11.482349 4.111641 11.251583 4.3483276 10.943882 C 4.3483276 10.943882 4.981468 10.115475 4.981468 10.115475 C 4.981468 10.115475 18.744911 -7.861019 18.744911 -7.861019 C 18.744911 -7.861019 18.738998 -7.861019 18.738998 -7.861019 Z" fill="none" stroke="#f4f4f4" stroke-width="2.2" opacity="1" stroke-linecap="round" stroke-linejoin="round" /></g><g transform="matrix(1.009840965270996,-1.009840965270996,1.0098412036895752,1.0098412036895752,46.5916862487793,7.677318572998047)"><path d="M 4.4005737 -4.384655 C 4.4005737 -4.384655 -15.953283 -11.645077 -15.953283 -11.645077 C -18.255081 -12.497154 -20.243265 -9.810741 -18.752127 -7.858059 C -18.752127 -7.858059 -4.355543 10.940929 -4.355543 10.940929 C -4.1188545 11.248623 -3.8170757 11.479397 -3.473877 11.645077 C -3.473877 11.645077 -2.995945 11.591824 -2.995945 11.591824 C -2.995945 11.591824 18.752129 1.2251587 18.752129 1.2251587 C 18.752129 1.2251587 4.4005737 -4.384655 4.4005737 -4.384655 Z" fill="none" stroke="#f4f4f4" stroke-width="2.2" opacity="1" stroke-linecap="round" stroke-linejoin="round" /></g><g transform="matrix(1.009840965270996,-1.009840965270996,1.0098412036895752,1.0098412036895752,80.90904235839844,-42.90309524536133)"><path d="M -9.04097 3.592785 C -9.04097 3.592785 11.37883 -3.5927887 11.37883 -3.5927887 C 11.37883 -3.5927887 -11.398457 -0.45887756 -11.378834 -0.47995758 Z" fill="none" stroke="#f4f4f4" stroke-width="2.2" opacity="1" stroke-linecap="round" stroke-linejoin="round" /></g><g transform="matrix(1.009840965270996,-1.009840965270996,1.0098412036895752,1.0098412036895752,33.86940383911133,4.280998229980469)"><path d="M 11.335749 -0.37877655 C 11.335749 -0.37877655 -11.33575 -3.6643143 -11.33575 -3.6643143 C -11.33575 -3.6643143 9.0574665 3.733799 9.08959 3.6643105 Z" fill="none" stroke="#f4f4f4" stroke-width="2.2" opacity="1" stroke-linecap="round" stroke-linejoin="round" /></g><g transform="matrix(1.009840965270996,-1.009840965270996,1.0098412036895752,1.0098412036895752,84.59190368652344,-14.523822784423828)"><path d="M -11.073921 -6.597698 C -11.073921 -6.597698 -11.127293 2.8606186 -11.127293 2.8606186 C -11.127293 2.8606186 -11.073921 6.5976944 -11.073921 6.5976944 C -11.073921 6.5976944 10.352135 4.0651245 10.352135 4.0651245 C 10.624329 4.0355377 10.884682 3.946785 11.127289 3.8284378 C 11.127289 3.8284378 3.831543 0.40236664 3.831543 0.40236664 C 3.831543 0.40236664 -11.073921 -6.597698 -11.073921 -6.597698 Z" fill="none" stroke="#f4f4f4" stroke-width="2.2" opacity="1" stroke-linecap="round" stroke-linejoin="round" /></g><g transform="matrix(1.009840965270996,-1.009840965270996,1.0098412036895752,1.0098412036895752,62.196083068847656,7.86004638671875)"><path d="M 11.097736 -6.591774 C 11.097736 -6.591774 -11.103653 3.8284378 -11.103653 3.8284378 C -10.861048 3.946785 -10.600689 4.0355453 -10.32258 4.0651245 C -10.32258 4.0651245 11.103653 6.5976944 11.103653 6.5976944 C 11.103653 6.5976944 11.103653 -6.5976906 11.103653 -6.5976906 C 11.103653 -6.5976906 11.097736 -6.591774 11.097736 -6.591774 Z" fill="none" stroke="#f4f4f4" stroke-width="2.2" opacity="1" stroke-linecap="round" stroke-linejoin="round" /></g><g transform="matrix(1.009840965270996,-1.009840965270996,1.0098412036895752,1.0098412036895752,59.65917205810547,-31.278121948242188)"><path d="M 7.190544 8.365532 C 7.190544 8.365532 5.0228386 4.4864006 5.0228386 4.4864006 C 5.0228386 4.4864006 -4.2612724 -12.413162 -4.2612724 -12.413162 C -4.8589096 -13.507847 -5.941761 -14.052231 -7.0246124 -14.052231 C -7.0246124 -14.052231 -7.228874 -0.051570892 -7.228874 -0.051570892 C -7.228874 -0.051570892 -7.0246124 14.052227 -7.0246124 14.052227 C -7.0246124 14.052227 7.228874 8.365532 7.228874 8.365532 Z" fill="none" stroke="#f4f4f4" stroke-width="2.2" opacity="1" stroke-linecap="round" stroke-linejoin="round" /></g><g transform="matrix(1.009840965270996,-1.009840965270996,1.0098412036895752,1.0098412036895752,45.37178421020508,-17.000362396240234)"><path d="M 7.1188965 14.047466 C 7.1188965 14.047466 7.1188965 -14.047468 7.1188965 -14.047468 C 6.036049 -14.047468 4.9531975 -13.503084 4.3555603 -12.414316 C 4.3555603 -12.414316 2.195778 -8.47937 2.195778 -8.47937 C 2.195778 -8.47937 -3.8042793 2.4438095 -3.8042793 2.4438095 C -3.8042793 2.4438095 -4.881855 4.4738884 -4.881855 4.4738884 C -4.881855 4.4738884 -7.1110077 8.4982605 -7.1188965 8.506149 Z" fill="none" stroke="#f4f4f4" stroke-width="2.2" opacity="1" stroke-linecap="round" stroke-linejoin="round" /></g></g></g>';

export class AboutDialog {
    private overlay: HTMLElement;

    constructor() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay';
        this.overlay.style.display = 'none';
        this.build();
        document.body.appendChild(this.overlay);

        // Click on the backdrop (not the card) closes.
        this.overlay.addEventListener('click', (e: MouseEvent) => {
            if (e.target === this.overlay) this.close();
        });
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.isOpen()) this.close();
        });
    }

    private build(): void {
        const card = document.createElement('div');
        card.className = 'modal-card about-card';
        card.addEventListener('click', (e: MouseEvent) => e.stopPropagation());

        card.innerHTML = `
            <div class="about-logo">
                <svg width="52" height="52" viewBox="0 0 98 98" xmlns="http://www.w3.org/2000/svg" aria-label="Editor">
                    <defs>
                        <linearGradient id="about-vector-tile" x1="0" y1="0" x2="0" y2="98" gradientUnits="userSpaceOnUse">
                            <stop stop-color="#242424" />
                            <stop offset="1" stop-color="#141414" />
                        </linearGradient>
                    </defs>
                    <rect x="0.75" y="0.75" width="96.5" height="96.5" rx="21.5" fill="url(#about-vector-tile)" stroke="#ffffff" stroke-opacity="0.14" stroke-width="1.5" />
                    ${MARK}
                </svg>
            </div>
            <div class="about-title">Vector editor</div>
            <div class="about-tagline">Professional In-Browser SVG Graphics Editor</div>
            <div class="about-version">Version ${pkg.version}</div>

            <div class="about-divider"></div>

            <div class="about-credit">
                Done with care by
                <a href="https://rebase.pro" target="_blank" rel="noopener noreferrer" class="about-link">rebase.pro</a>
            </div>
            <div class="about-contact">
                <a href="mailto:hello@rebase.pro" class="about-email">hello@rebase.pro</a>
            </div>
            <div class="about-legal">
                <a href="#/privacy" target="_blank" rel="noopener noreferrer" class="about-link">Privacy Policy</a>
                <span class="about-legal-sep">·</span>
                <a href="#/terms" target="_blank" rel="noopener noreferrer" class="about-link">Terms of Service</a>
            </div>

            <div class="modal-actions about-actions">
                <button class="header-btn header-btn-primary" id="about-close">Close</button>
            </div>
        `;
        this.overlay.appendChild(card);

        (card.querySelector('#about-close') as HTMLButtonElement).addEventListener('click', () =>
            this.close(),
        );
    }

    open(): void {
        this.overlay.style.display = 'flex';
    }

    close(): void {
        this.overlay.style.display = 'none';
    }

    private isOpen(): boolean {
        return this.overlay.style.display !== 'none';
    }
}
