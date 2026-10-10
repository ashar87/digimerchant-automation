import { html } from './html.js';
import { inboxPage } from './views/inbox.js';
import { ordersPage, createOrder, orderPage, editInvoicePage, saveInvoice, deleteInvoice, markReviewed, addWriteOff } from './views/orders.js';
import { paymentsPage, paymentForm, savePayment, deletePayment } from './views/payments.js';
import { shipmentsPage, shipmentForm, saveShipment, deleteShipment } from './views/shipments.js';
import { costsPage, batchPage } from './views/costs.js';
import { productsPage, productPage, saveProduct, deleteProduct } from './views/products.js';
import { billsPage, billPage, saveBill, deleteBill } from './views/bills.js';
import { sellerboardPage, sellerboardCsv, publishSellerboard } from './views/sellerboard.js';
import { anniePage } from './views/annie.js';
import { settingsPage, saveSettings } from './views/settings.js';
import { runAmazonSync, replyToCard, messagesPage } from './views/amazon.js';
import { wisePage, fetchWise, ignoreTransfer, lookupRate } from './views/wise.js';
import { invoicesPage, uploadInvoice, draftPage, saveDraft, discardDraft, draftFile } from './views/invoices.js';

const SEG = '([^/]+)';
const r = (method, path, handler) => ({ method, pattern: new RegExp(`^${path.replace(/:seg/g, SEG)}/?$`), handler });

export const routes = [
  r('GET', '/', inboxPage),
  // Placeholder until the task board is built (next step).
  r('GET', '/tasks', () => ({ title: 'Tasks', body: html`<h1>Tasks</h1><p class="sub">The task board is being built: New, In Progress and Done, with tasks from WhatsApp and ones you add yourself.</p>` })),

  r('GET', '/orders', ordersPage),
  r('POST', '/orders', createOrder),
  r('GET', '/orders/:seg', orderPage),
  r('POST', '/orders/:seg/review', markReviewed),
  r('POST', '/orders/:seg/write-offs', addWriteOff),
  r('POST', '/orders/:seg/invoices', saveInvoice),
  r('GET', '/orders/:seg/invoices/:seg', editInvoicePage),
  r('POST', '/orders/:seg/invoices/:seg/delete', deleteInvoice),
  r('POST', '/orders/:seg/invoices/:seg', saveInvoice),

  r('GET', '/invoices', invoicesPage),
  r('POST', '/invoices/upload', uploadInvoice),
  r('GET', '/invoices/drafts/:seg', draftPage),
  r('GET', '/invoices/drafts/:seg/file', draftFile),
  r('POST', '/invoices/drafts/:seg/save', saveDraft),
  r('POST', '/invoices/drafts/:seg/discard', discardDraft),

  r('GET', '/payments', paymentsPage),
  r('GET', '/payments/new', paymentForm),
  r('POST', '/payments', savePayment),
  r('POST', '/payments/:seg/delete', deletePayment),
  r('POST', '/payments/:seg/qb-rate', lookupRate),
  r('GET', '/wise', wisePage),
  r('POST', '/wise/fetch', fetchWise),
  r('POST', '/wise/:seg/ignore', ignoreTransfer),
  r('GET', '/payments/:seg', paymentForm),
  r('POST', '/payments/:seg', savePayment),

  r('GET', '/shipments', shipmentsPage),
  r('GET', '/shipments/new', shipmentForm),
  r('POST', '/shipments', saveShipment),
  r('POST', '/shipments/:seg/delete', deleteShipment),
  r('GET', '/shipments/:seg', shipmentForm),
  r('POST', '/shipments/:seg', saveShipment),

  r('GET', '/bills', billsPage),
  r('GET', '/bills/new', billPage),
  r('POST', '/bills', saveBill),
  r('POST', '/bills/:seg/delete', deleteBill),
  r('GET', '/bills/:seg', billPage),
  r('POST', '/bills/:seg', saveBill),

  r('GET', '/sellerboard', sellerboardPage),
  r('GET', '/sellerboard\\.csv', sellerboardCsv),
  r('POST', '/sellerboard/publish', publishSellerboard),

  r('GET', '/costs', costsPage),
  r('GET', '/costs/:seg/:seg', batchPage),

  r('GET', '/products', productsPage),
  r('POST', '/products', saveProduct),
  r('POST', '/products/:seg/delete', deleteProduct),
  r('GET', '/products/:seg', productPage),
  r('POST', '/products/:seg', saveProduct),

  r('POST', '/amazon/sync', runAmazonSync),
  r('POST', '/cards/:seg/reply', replyToCard),
  r('GET', '/messages', messagesPage),

  r('GET', '/annie', anniePage),
  r('GET', '/settings', settingsPage),
  r('POST', '/settings', saveSettings),
];
