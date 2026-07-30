import { Schema, Connection, Model, Document } from 'mongoose';

function getElapsedMonthsAndDays(dateStr: string) {
  if (!dateStr) return { months: 0, days: 0 };
  const start = new Date(dateStr);
  start.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  if (now.getTime() <= start.getTime()) return { months: 0, days: 0 };

  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  let days = now.getDate() - start.getDate();

  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    days += prevMonth.getDate();
  }

  return { months, days };
}

function calculateCompoundInterest(principal: number, monthlyRatePct: number, months: number) {
  const totalPayable = principal * Math.pow(1 + monthlyRatePct / 100, months);
  const interest = totalPayable - principal;

  return {
    principal,
    interest: Number(interest.toFixed(2)),
    totalPayable: Number(totalPayable.toFixed(2)),
  };
}

interface IItem {
  id?: string;
  itemType: string;
  itemCategory?: string;
  itemDescription: string;
  grossWeight: number;
  netWeight: number;
  purity: string;
  marketValue?: number;
}

export interface IGirvi extends Document {
  date: string;
  loanNo: string;
  customerName: string;
  customerMobile: string;
  customerMobile2?: string;
  customerAddress?: string;
  items?: IItem[];
  itemType?: string;
  itemCategory?: string;
  itemDescription?: string;
  grossWeight?: number;
  netWeight?: number;
  purity?: string;
  marketValue?: number;
  loanAmount: number;
  interestPct: number;
  documentType?: string;
  documentNumber?: string;
  imageUrl?: string;
  dueDate?: string;
  status: string;
  forwardedTo?: string;
  forwardedShopName?: string;
  forwardedShopGstNo?: string;
  forwardedShopAddress?: string;
  forwardedDate?: string;
  forwardedAmount?: number;
  forwardedInterestPct?: number;
  isForwardedSettled?: boolean;
  forwardedSettledDate?: string;
  forwardedSettledInterest?: number;
  forwardedImageUrl?: string;
  customerSignature?: string;
  authorizedSignatory?: string;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
  calculateInterestAmount(): number;
  calculateForwardedInterestAmount(): number;
}

const girviSchema = new Schema<IGirvi>(
  {
    date: { type: String, required: true },
    loanNo: { type: String, required: true },
    customerName: { type: String, required: true },
    customerMobile: { type: String },
    customerMobile2: { type: String },
    customerAddress: { type: String },
    items: [
      {
        id: { type: String },
        itemType: { type: String, required: true },
        itemCategory: { type: String },
        itemDescription: { type: String, required: true },
        grossWeight: { type: Number, required: true },
        netWeight: { type: Number, required: true },
        purity: { type: String, required: true },
        marketValue: { type: Number },
      },
    ],
    itemType: { type: String },
    itemCategory: { type: String },
    itemDescription: { type: String },
    grossWeight: { type: Number },
    netWeight: { type: Number },
    purity: { type: String },
    marketValue: { type: Number },
    loanAmount: { type: Number, required: true },
    interestPct: { type: Number, required: true },
    documentType: { type: String },
    documentNumber: { type: String },
    imageUrl: { type: String },
    dueDate: { type: String },
    status: { type: String, required: true, default: 'Active' },
    forwardedTo: { type: String },
    forwardedShopName: { type: String },
    forwardedShopGstNo: { type: String },
    forwardedShopAddress: { type: String },
    forwardedDate: { type: String },
    forwardedAmount: { type: Number },
    forwardedInterestPct: { type: Number },
    isForwardedSettled: { type: Boolean },
    forwardedSettledDate: { type: String },
    forwardedSettledInterest: { type: Number },
    forwardedImageUrl: { type: String },
    customerSignature: { type: String },
    authorizedSignatory: { type: String },
    note: { type: String },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

girviSchema.methods.calculateInterestAmount = function (this: IGirvi) {
  const principal = this.loanAmount || 0;
  const monthlyRatePct = this.interestPct || 0;
  const { months, days } = getElapsedMonthsAndDays(this.date);
  const totalMonths = months + days / 30;
  return Math.round(calculateCompoundInterest(principal, monthlyRatePct, totalMonths).interest);
};

girviSchema.methods.calculateForwardedInterestAmount = function (this: IGirvi) {
  const principal = this.forwardedAmount || 0;
  const monthlyRatePct = this.forwardedInterestPct || 0;
  const startDate = this.forwardedDate || this.date;
  const { months, days } = getElapsedMonthsAndDays(startDate);
  const totalMonths = months + days / 30;
  return Math.round(calculateCompoundInterest(principal, monthlyRatePct, totalMonths).interest);
};

girviSchema.virtual('interestAmount').get(function (this: IGirvi) {
  return this.calculateInterestAmount();
});

girviSchema.virtual('forwardedInterestAmount').get(function (this: IGirvi) {
  return this.calculateForwardedInterestAmount();
});

girviSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id;
    delete ret.__v;
    return ret;
  },
});

export function getGirviModel(conn: Connection): Model<IGirvi> {
  return (conn.models.Girvi as Model<IGirvi>) || conn.model<IGirvi>('Girvi', girviSchema);
}
