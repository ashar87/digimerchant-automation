import { inboxPage } from './views/inbox.js';
import { ordersPage, createOrder, orderPage, editInvoicePage, saveInvoice, deleteInvoice, markReviewed, addWriteOff } from './views/orders.js';
import { paymentsPage, paymentForm, savePayment, deletePayment } from './views/payments.js';
import { shipmentsPage, shipmentForm, saveShipment, deleteShipment } from './views/shipments.js';
import { costsPage, batchPage } from './views/costs.js';
import { productsPage, productPage, saveProduct, deleteProduct } from './views/products.js';
import { billsPage, billPage } from './views/bills.js';
import { anniePage } from './views/annie.js';
import { settingsPage, saveSettings } from './views/settings.js';
import { runAmazonSync, replyToCard, messagesPage } from './views/amazon.js';

const SEG = '([^/]+)';
const r = (method, path, handler) => ({ method, pattern: new RegExp(`^${path.replace(/:seg/g, SEG)}/?$`), handler });

export const routes = [
  r('GET', '/', inboxPage),

  r('GET', '/orders', ordersPage),
  r('POST', '/orders', createOrder),
  r('GET', '/orders/:seg', orderPage),
  r('POST', '/orders/:seg/review', markReviewed),
  r('POST', '/orders/:seg/write-offs', addWriteOff),
  r('POST', '/orders/:seg/invoices', saveInvoice),
  r('GET', '/orders/:seg/invoices/:seg', editInvoicePage),
  r('POST', '/orders/:seg/invoices/:seg/delete', deleteInvoice),
  r('POST', '/orders/:seg/invoices/:seg', saveInvoice),

  r('GET', '/payments', paymentsPage),
  r('GET', '/payments/new', paymentForm),
  r('POST', '/payments', savePayment),
  r('POST', '/payments/:seg/delete', deletePayment),
  r('GET', '/payments/:seg', paymentForm),
  r('POST', '/payments/:seg', savePayment),

  r('GET', '/shipments', shipmentsPage),
  r('GET', '/shipments/new', shipmentForm),
  r('POST', '/shipments', saveShipment),
  r('POST', '/shipments/:seg/delete', deleteShipment),
  r('GET', '/shipments/:seg', shipmentForm),
  r('POST', '/shipments/:seg', saveShipment),

  r('GET', '/bills', billsPage),
  r('GET', '/bills/:seg', billPage),

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
