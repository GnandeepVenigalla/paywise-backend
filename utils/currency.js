const axios = require('axios');

/**
 * Common exchange rates based on USD as the base (1 USD = X target).
 * Loaded initially with static defaults as fallback.
 */
const EXCHANGE_RATES = {
    USD: 1,       EUR: 0.866,  GBP: 0.751,  INR: 92.01,  JPY: 158.33,
    CAD: 1.360,   AUD: 1.433,  CNY: 6.914,  CHF: 0.781,  MXN: 17.90,
    BRL: 5.254,   KRW: 1483.8, SGD: 1.282,  HKD: 7.820,  SEK: 9.260,
    NOK: 9.643,   DKK: 6.462,  NZD: 1.708,  ZAR: 16.74,  AED: 3.673,
};

/**
 * Intelligently grabs live global currency rates and updates the static dictionary.
 */
const updateRates = async () => {
    try {
        const response = await axios.get('https://open.er-api.com/v6/latest/USD');
        if (response.data && response.data.rates) {
            Object.assign(EXCHANGE_RATES, response.data.rates);
            console.log('[Currency] Live global exchange rates updated successfully.');
        }
    } catch (err) {
        console.warn('[Currency] Failed to fetch live global rates, falling back to static cache.');
    }
};

/**
 * Converts an amount from one currency to another
 * @param {number} amount - The numeric amount
 * @param {string} from - Source ISO code (default: 'USD')
 * @param {string} to - Target ISO code (default: 'USD')
 */
const convertAmount = (amount, from = 'USD', to = 'USD') => {
    if (!amount) return 0;
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    if (f === t) return amount;
    const rate_from = EXCHANGE_RATES[f] || 1;
    const rate_to = EXCHANGE_RATES[t] || 1;
    return amount * (rate_to / rate_from);
};

/**
 * Get the currency symbol for a given currency code.
 */
const getCurrencySymbol = (code) => {
    const symbols = {
        USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥',
        CAD: 'CA$', AUD: 'A$', CHF: 'Fr', CNY: '¥', MXN: 'MX$',
        BRL: 'R$', KRW: '₩', SGD: 'S$', HKD: 'HK$',
        SEK: 'kr', NOK: 'kr', DKK: 'kr', NZD: 'NZ$', ZAR: 'R', AED: 'د.إ',
    };
    return symbols[code?.toUpperCase()] || '$';
};

module.exports = {
    convertAmount,
    EXCHANGE_RATES,
    updateRates,
    getCurrencySymbol
};
