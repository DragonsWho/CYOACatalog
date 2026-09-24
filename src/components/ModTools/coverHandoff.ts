// Screenshot Studio → Mod Tools cover handoff. Studio is opened in a new tab with ?handoff=<id>;
// "Use as cover" posts the capture on this same-origin channel, the Mod Tools tab listens for its id.
export const COVER_HANDOFF_CHANNEL = 'cyoa-modtools-cover';

export interface CoverHandoffMessage {
  handoff: string;
  blob: Blob;
  placeholder: string;
}
