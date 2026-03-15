const axios = require('axios');

/**
 * Common exchange rates based on USD as the base (1 USD = X target).
 * Loaded initially with static defaults as fallback.
 */
const EXCHANGE_RATES = {
    USD: 1, EUR: 0.92, GBP: 0.79, INR: 83.12, JPY: 150.15,
    CAD: 1.35, AUD: 1.52, CNY: 7.19, CHF: 0.88, MXN: 17.05,
    BRL: 4.97, KRW: 1332.50, SGD: 1.34, HKD: 7.82, SEK: 10.35,
    NOK: 10.55, DKK: 6.85, NZD: 1.63, ZAR: 19.10, AED: 3.67,
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
    if (!amount || from === to) return amount;
    const rate_from = EXCHANGE_RATES[from] || 1;
    const rate_to = EXCHANGE_RATES[to] || 1;
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
    return symbols[code] || '$';
};

module.exports = {
    convertAmount,
    EXCHANGE_RATES,
    updateRates,
    getCurrencySymbol
};
