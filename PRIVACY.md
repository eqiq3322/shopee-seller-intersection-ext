# Privacy Policy for Shopee Same-Store Finder

**Last Updated: May 25, 2026**

This privacy policy governs the use of the "Shopee Same-Store Finder" Chrome extension. We are committed to protecting your privacy. This extension is designed to process data locally within your browser to enhance your shopping experience on Shopee, with an optional feedback form that can send limited diagnostic context when you choose to submit feedback.

## 1. Why we need permissions

### "activeTab", "storage", Shopee host permissions, and feedback endpoint permissions
We request only the minimum permissions needed for core features:
* **activeTab:** Used only after user interaction with the extension popup, so the extension can work with the currently active Shopee tab.
* **storage:** Used to save your keyword list, progress, and local results on your device.
* **Shopee host permissions:** Required so the extension popup can request Shopee shop detail endpoints to display shop names for collected shop IDs.
* **Google Apps Script host permissions (`script.google.com` and `script.googleusercontent.com`):** Used only for the optional feedback form so your submitted feedback can be delivered to the developer's Google Apps Script endpoint.

The extension runs its content script only on supported Shopee search pages declared in `content_scripts.matches`.

## 2. What data is handled

The extension temporarily handles the following non-personal information directly related to your search query:
* **Product Keywords and IDs:** The search terms you enter into the extension.
* **Public Shopee Data:** Publicly available data scraped from Shopee search results pages, such as shop names, shop IDs, product titles, and prices.

**Crucially:**
* **We do NOT collect personal identification information (PII).**
* We do NOT collect your Shopee login credentials, passwords, or payment information.
* We do NOT track your browsing activity outside the specific Shopee pages required for the extension to function.
* When you voluntarily submit the feedback form, we send the feedback text together with limited technical metadata needed for support: extension version, UI language, Shopee domain, and page type (`search`, `shop`, `product`, or `other`).
* We do **not** send the full page URL, account identifiers, payment information, or unrelated browsing history through the feedback form.

## 3. How data is used

* Core search and seller-intersection processing occurs **locally on your device**.
* The information gathered from Shopee pages is used solely in real-time to group products by the same seller and display these results to you in the extension popup.
* If you submit feedback, the feedback message and the limited technical metadata described above are transmitted to the developer's Google Apps Script feedback endpoint for support and debugging purposes.

## 4. Data Sharing and Third Parties

* We do **not** sell, trade, or otherwise transfer any data handled by this extension to outside parties.
* Feedback submitted through the optional feedback form is stored in the developer's Google Sheet only for support, bug investigation, and product improvement.
* The extension interacts directly with Shopee's websites. Your interactions with Shopee are governed by Shopee's own privacy policy and terms of service.

## 5. Disclaimer

This extension is an independent project developed to improve the user experience. **It is not affiliated with, endorsed by, or connected to Shopee or any of its subsidiaries.**

## 6. Changes to this Policy

We may update this privacy policy from time to time. If we make material changes, we will notify users by updating the date at the top of this policy.

## 7. Contact Us

If you have questions about this policy or the extension's practices, please contact the developer via:
* The support section on the Chrome Web Store listing page.
* https://github.com/eqiq3322/shopee-seller-intersection-ext.git
