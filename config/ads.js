/**
 * =========================================================================
 *                   ANIMETSU CENTRAL AD CONFIGURATION
 * =========================================================================
 * 
 * You can change all ad links, enable/disable ads, and configure triggers
 * right from this single file. No need to touch any other code!
 * 
 * Quick Instructions:
 * - To change an ad link: Replace the URL inside "url: '...'"
 * - To turn off an ad: Set "enabled: false"
 * - To turn off all ads completely: Set the top-level "enabled: false"
 * =========================================================================
 */

(function (root) {
  const ADS_CONFIG = {
    // -----------------------------------------------------------------------
    // Master Switch: Set to false to instantly turn off ALL ads across the site
    // -----------------------------------------------------------------------
    enabled: false,

    // -----------------------------------------------------------------------
    // Ad Cooldown Timer (in seconds)
    // 180 = 3 Minutes Cooldown for Home & Watch pages
    // -----------------------------------------------------------------------
    cooldownSeconds: 180,

    // -----------------------------------------------------------------------
    // Watch Page Script Ad Cooldown Timer (in seconds)
    // 3600 = 1 Hour Cooldown
    // -----------------------------------------------------------------------
    watchScriptCooldownSeconds: 3600,

    // -----------------------------------------------------------------------
    // Allowed Pages for Smartlink Pop Ads: all pages allowed
    // -----------------------------------------------------------------------
    allowedPages: ['*'],

    // -----------------------------------------------------------------------
    // 1. General Pages Smartlink Pop Ad (1st click per page navigation)
    // -----------------------------------------------------------------------
    smartlink: {
      enabled: false,
      url: "https://araplhn.org/4/38d5299bb0db3daa8c4c4046a96be571"
    },

    // -----------------------------------------------------------------------
    // 1b. Home Page Specific Pop Ad (Smartlink with 3m Cooldown)
    // -----------------------------------------------------------------------
    homeSmartlink: {
      enabled: false,
      url: "https://araplhn.org/4/38d5299bb0db3daa8c4c4046a96be571",
      cooldownSeconds: 180
    },

    // -----------------------------------------------------------------------
    // 1c. Watch Page Specific Pop Ad (Smartlink with 3m Cooldown)
    // -----------------------------------------------------------------------
    watchSmartlink: {
      enabled: false,
      url: "https://araplhn.org/4/38d5299bb0db3daa8c4c4046a96be571",
      cooldownSeconds: 180
    },

    // -----------------------------------------------------------------------
    // 1d. Home Page Script Ad (Disabled: using Direct Smartlink with 3m cooldown)
    // -----------------------------------------------------------------------
    homeScript: {
      enabled: false,
      src: "https://abscloud.org/1/26a58cc79b0fa7a9c1bb92df2e7c96a9"
    },

    // -----------------------------------------------------------------------
    // 1e. Watch Page Script Ad (Active: 1 Hour Cooldown)
    // -----------------------------------------------------------------------
    watchScript: {
      enabled: false,
      src: "https://abscloud.org/1/26a58cc79b0fa7a9c1bb92df2e7c96a9",
      cooldownSeconds: 3600
    },

    // -----------------------------------------------------------------------
    // 2. Server Button Pop Ad
    // Triggers when user clicks the "Server" button or selects a server on Watch Page
    // -----------------------------------------------------------------------
    serverAd: {
      enabled: false,
      url: "https://araplhn.org/4/38d5299bb0db3daa8c4c4046a96be571"
    },

    // -----------------------------------------------------------------------
    // 3. Download Button Pop Ad
    // Triggers on the 1st click of a download option before downloading
    // -----------------------------------------------------------------------
    downloadAd: {
      enabled: false,
      url: "https://araplhn.org/4/38d5299bb0db3daa8c4c4046a96be571"
    },

    // -----------------------------------------------------------------------
    // Helper Methods (Used internally by the app)
    // -----------------------------------------------------------------------
    getCooldownSeconds(pageKey) {
      if (pageKey === 'watch') return this.watchSmartlink?.cooldownSeconds || this.cooldownSeconds || 180;
      if (pageKey === 'home') return this.homeSmartlink?.cooldownSeconds || this.cooldownSeconds || 180;
      return this.cooldownSeconds || 180;
    },
    getWatchScriptCooldown() {
      return this.watchScript?.cooldownSeconds || this.watchScriptCooldownSeconds || 3600;
    },
    getSmartlinkUrl(pageKey) {
      if (!this.enabled) return null;
      if (pageKey === 'home' && this.homeSmartlink && this.homeSmartlink.enabled) {
        return this.homeSmartlink.url;
      }
      if (pageKey === 'watch' && this.watchSmartlink && this.watchSmartlink.enabled) {
        return this.watchSmartlink.url;
      }
      return (this.smartlink && this.smartlink.enabled) ? this.smartlink.url : null;
    },
    getHomeScriptSrc() {
      return (this.enabled && this.homeScript && this.homeScript.enabled) ? this.homeScript.src : null;
    },
    getWatchScriptSrc() {
      return (this.enabled && this.watchScript && this.watchScript.enabled) ? this.watchScript.src : null;
    },
    getServerAdUrl() {
      return (this.enabled && this.serverAd && this.serverAd.enabled) ? this.serverAd.url : null;
    },
    getDownloadAdUrl() {
      return (this.enabled && this.downloadAd && this.downloadAd.enabled) ? this.downloadAd.url : null;
    }
  };

  root.__ANIMETSU_ADS_CONFIG__ = ADS_CONFIG;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ADS_CONFIG;
  }
})(typeof window !== 'undefined' ? window : globalThis);
