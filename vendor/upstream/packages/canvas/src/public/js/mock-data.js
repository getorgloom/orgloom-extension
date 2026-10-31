(function () {
	'use strict';
	// Deterministic playground fixtures that mimic standard and custom Salesforce schema.

	function mockId(prefix, n) {
		const padded = String(n).padStart(12, '0');
		return prefix + padded + 'AAA';
	}

	function pick(arr, i) {
		return arr[i % arr.length];
	}

	function companySlug(name) {
		return String(name || '')
			.replace(/\s*\(Demo\)\s*$/i, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '');
	}

	const COMPANY_NAMES = [
		'Alder Peak Analytics (Demo)',
		'Beacon Grove Manufacturing (Demo)',
		'Cedarline Systems (Demo)',
		'Driftwood Logistics (Demo)',
		'Ember Ridge Energy (Demo)',
		'Fernbridge Retail (Demo)',
		'Granite Loop Financial (Demo)',
		'Harborlight Health (Demo)',
		'Ironleaf Communications (Demo)',
		'Juniper Vale Media (Demo)',
		'Kestrel Works (Demo)',
		'Lantern Field Education (Demo)',
		'Maple Circuit Technologies (Demo)',
		'Morrow Bay Services (Demo)',
		'Orchard Peak Foods (Demo)',
		'Prairie Cloud Software (Demo)',
		'Quartz River Consulting (Demo)',
		'Redwood Arc Manufacturing (Demo)',
		'Silver Finch Labs (Demo)',
		'Timberline Support (Demo)',
		'Umber Field Design (Demo)',
		'Violet Harbor Imports (Demo)',
		'Willow Grid Energy (Demo)',
		'Zephyr Lane Logistics (Demo)',
		'Aspen Thread Apparel (Demo)',
		'Birch & Beam Construction (Demo)',
		'Copper Meadow Robotics (Demo)',
		'Dovetail Data Systems (Demo)',
		'Evergreen Relay Telecom (Demo)',
		'Frostline Cold Storage (Demo)',
		'Grovepath Agriculture (Demo)',
		'Highland Circuit Electronics (Demo)',
		'Indigo Harbor Insurance (Demo)',
		'Junction Bloom Biotech (Demo)',
		'Kindred Mesa Hospitality (Demo)',
		'Larkspur Fleet Services (Demo)',
		'Moonrise Paper Goods (Demo)',
		'Noble Acre Property Management (Demo)',
		'Openfield Learning (Demo)',
		'Pineglass Security (Demo)',
		'Quiet River Publishing (Demo)',
		'Ridgeway Medical Devices (Demo)',
		'Sandbar Travel (Demo)',
		'Thistle & Stone Furnishings (Demo)',
		'Uplands Market Research (Demo)',
		'Verdant Rail Transportation (Demo)',
		'Westward Beacon Advertising (Demo)',
		'Yarrow Point Engineering (Demo)',
		'Zincwood Hardware (Demo)',
		'Amber Thread Textiles (Demo)',
		'Bramble Creek Beverages (Demo)',
	];

	const INDUSTRIES = [
		'Technology',
		'Manufacturing',
		'Finance',
		'Healthcare',
		'Retail',
		'Energy',
		'Telecommunications',
		'Media',
		'Education',
		'Transportation',
	];

	const ACCOUNT_TYPES = ['Customer - Direct', 'Customer - Channel', 'Prospect', 'Partner'];

	const FIRST_NAMES = [
		'Rowan',
		'Casey',
		'Morgan',
		'Riley',
		'Quinn',
		'Avery',
		'Parker',
		'Reese',
		'Skylar',
		'Drew',
		'Sam',
		'Alex',
		'Taylor',
		'Jamie',
		'Pat',
		'Robin',
		'Adrian',
		'Blake',
		'Cameron',
		'Dakota',
		'Emerson',
		'Finley',
		'Greer',
		'Harper',
		'Indigo',
		'Jules',
		'Kai',
		'Logan',
		'Mason',
		'Nova',
	];

	const LAST_NAMES = [
		'Chen',
		'Patel',
		'Garcia',
		'Singh',
		'Khan',
		'Nguyen',
		'Kim',
		'Park',
		'Rodriguez',
		'Johnson',
		'Smith',
		'Williams',
		'Brown',
		'Davis',
		'Miller',
		'Anderson',
		'Thomas',
		'Jackson',
		'White',
		'Harris',
		'Martin',
		'Thompson',
		'Walker',
		'Lewis',
		'Hall',
		'Allen',
		'Young',
		'Hernandez',
		'King',
		'Wright',
	];

	const OPP_STAGES = [
		'Prospecting',
		'Qualification',
		'Needs Analysis',
		'Value Proposition',
		'Id. Decision Makers',
		'Perception Analysis',
		'Proposal/Price Quote',
		'Negotiation/Review',
		'Closed Won',
		'Closed Lost',
	];

	const LEAD_STATUSES = [
		'Open - Not Contacted',
		'Working - Contacted',
		'Closed - Converted',
		'Closed - Not Converted',
	];

	const LEAD_SOURCES = ['Web', 'Phone Inquiry', 'Partner Referral', 'Purchased List', 'Other'];

	const SALUTATIONS = ['Mr.', 'Ms.', 'Mrs.', 'Dr.', 'Prof.'];
	const RATINGS = ['Hot', 'Warm', 'Cold'];
	const OWNERSHIPS = ['Public', 'Private', 'Subsidiary', 'Other'];
	const ACCOUNT_SOURCES = ['Web', 'Phone Inquiry', 'Partner Referral', 'Purchased List', 'Other'];
	const FORECAST_CATEGORIES = ['Pipeline', 'BestCase', 'Commit', 'Closed', 'Omitted'];
	const FORECAST_CATEGORY_NAMES = ['Pipeline', 'Best Case', 'Commit', 'Closed', 'Omitted'];

	const CASE_STATUSES = ['New', 'Working', 'Escalated', 'Closed'];
	const CASE_PRIORITIES = ['High', 'Medium', 'Low'];
	const CASE_ORIGINS = ['Phone', 'Email', 'Web', 'Chat'];
	const CASE_TYPES = ['Question', 'Problem', 'Feature Request'];
	const CASE_REASONS = ['Installation', 'Equipment Complexity', 'Performance', 'Breakdown', 'Equipment Design'];
	const TASK_STATUSES = ['Not Started', 'In Progress', 'Completed', 'Waiting on someone else', 'Deferred'];
	const TASK_PRIORITIES = ['High', 'Normal', 'Low'];
	const TASK_SUBJECTS = ['Call', 'Email', 'Send Letter', 'Send Quote', 'Other'];
	const EVENT_SUBJECTS = ['Meeting', 'Call', 'Email', 'Send Letter', 'Other'];
	const CAMPAIGN_TYPES = [
		'Conference',
		'Webinar',
		'Trade Show',
		'Public Relations',
		'Partners',
		'Referral Program',
		'Advertisement',
		'Direct Mail',
		'Email',
		'Telemarketing',
		'Other',
	];
	const CAMPAIGN_STATUSES = ['Planned', 'In Progress', 'Completed', 'Aborted'];
	const CAMPAIGN_MEMBER_STATUSES = ['Sent', 'Responded'];
	const PRODUCT_FAMILIES = ['Software', 'Hardware', 'Services', 'Support'];
	const CONTRACT_STATUSES = ['Draft', 'In Approval Process', 'Activated', 'Terminated', 'Expired'];
	const ORDER_STATUSES = ['Draft', 'Activated'];
	const ORDER_TYPES = ['New', 'Renewal', 'Upgrade'];
	const QUOTE_STATUSES = [
		'Draft',
		'Needs Review',
		'In Review',
		'Approved',
		'Rejected',
		'Presented',
		'Accepted',
		'Denied',
	];
	const ASSET_STATUSES = ['Purchased', 'Shipped', 'Installed', 'Registered', 'Obsolete'];

	function userRow(id, firstName, lastName, email, alias, title) {
		return {
			Id: id,
			Username: email,
			FirstName: firstName,
			LastName: lastName,
			Name: firstName + ' ' + lastName,
			Alias: alias,
			Email: email,
			Title: title,
			Department: 'Sales',
			Phone: null,
			IsActive: true,
			UserType: 'Standard',
			TimeZoneSidKey: 'America/Los_Angeles',
			LocaleSidKey: 'en_US',
			LanguageLocaleKey: 'en_US',
			EmailEncodingKey: 'UTF-8',
		};
	}
	const USERS = [
		userRow('005DEMO00000000AAA', 'Demo', 'User', 'demo.user@example.com', 'duser', 'Salesforce Admin'),
		userRow(mockId('005', 1), 'Avery', 'Monroe', 'avery.monroe@example.com', 'amonr', 'Account Executive'),
		userRow(mockId('005', 2), 'Casey', 'Chen', 'casey.chen@example.com', 'cchen', 'Senior AE'),
		userRow(mockId('005', 3), 'Morgan', 'Patel', 'morgan.patel@example.com', 'mpate', 'Sales Manager'),
		userRow(mockId('005', 4), 'Riley', 'Garcia', 'riley.garcia@example.com', 'rgarc', 'Sales Engineer'),
	];

	const ACCOUNTS = COMPANY_NAMES.map((name, i) => {
		const owner = pick(USERS, i);
		const city = pick(
			['San Francisco', 'New York', 'Austin', 'Chicago', 'Seattle', 'Boston', 'Denver', 'Atlanta'],
			i,
		);
		const state = pick(['CA', 'NY', 'TX', 'IL', 'WA', 'MA', 'CO', 'GA'], i);
		const postal = String(94000 + ((i * 137) % 5000));
		const street =
			String(100 + ((i * 17) % 9000)) +
			' ' +
			pick(['Market', 'Main', 'Mission', 'Oak', 'Elm', 'Cedar', 'Pine', 'Maple'], i) +
			' St';
		return {
			Id: mockId('001', i + 1),
			Name: name,
			AccountNumber: 'CD' + String(i + 1).padStart(6, '0'),
			Industry: pick(INDUSTRIES, i),
			Type: pick(ACCOUNT_TYPES, i),
			Rating: pick(RATINGS, i),
			Ownership: pick(OWNERSHIPS, i),
			AccountSource: pick(ACCOUNT_SOURCES, i),
			Phone: '(212) 555-' + String(100 + (i % 100)).padStart(4, '0'),
			Fax: '(212) 555-' + String(150 + (i % 50)).padStart(4, '0'),
			Website: 'https://' + companySlug(name) + '.example.com',
			AnnualRevenue: 1_000_000 + ((i * 137_000) % 90_000_000),
			NumberOfEmployees: 5 + ((i * 13) % 5000),
			OwnerId: owner.Id,
			ParentId: i % 5 === 1 || i % 5 === 2 || i % 5 === 3 ? mockId('001', i - (i % 5) + 1) : null,
			BillingStreet: street,
			BillingCity: city,
			BillingState: state,
			BillingPostalCode: postal,
			BillingCountry: 'USA',
			ShippingStreet: street,
			ShippingCity: city,
			ShippingState: state,
			ShippingPostalCode: postal,
			ShippingCountry: 'USA',
			Description: 'A ' + pick(INDUSTRIES, i).toLowerCase() + ' company with operations across the demo region.',
			CreatedDate: new Date(2024, i % 12, 1 + (i % 27)).toISOString(),
			LastModifiedDate: new Date(2025, i % 12, 1 + (i % 27)).toISOString(),
		};
	});

	const CONTACTS = [];
	let contactIdx = 0;
	for (let ai = 0; ai < ACCOUNTS.length; ai++) {
		const account = ACCOUNTS[ai];
		const contactCount = 3 + (ai % 3); // 3, 4, or 5 contacts per account
		for (let ci = 0; ci < contactCount; ci++) {
			const first = pick(FIRST_NAMES, contactIdx + ai);
			const last = pick(LAST_NAMES, contactIdx);
			const owner = pick(USERS, contactIdx);
			CONTACTS.push({
				Id: mockId('003', contactIdx + 1),
				Salutation: pick(SALUTATIONS, contactIdx),
				FirstName: first,
				LastName: last,
				Name: first + ' ' + last,
				Email: (first + '.' + last).toLowerCase() + '@' + companySlug(account.Name) + '.example.com',
				Phone: '(212) 555-' + String(100 + (contactIdx % 100)).padStart(4, '0'),
				MobilePhone: '(646) 555-' + String(100 + (contactIdx % 100)).padStart(4, '0'),
				Title: pick(
					['CEO', 'CTO', 'VP Sales', 'Director', 'Manager', 'Engineer', 'Analyst', 'Coordinator'],
					contactIdx,
				),
				Department: pick(['Sales', 'Engineering', 'Operations', 'Marketing', 'Finance', 'HR'], contactIdx),
				LeadSource: pick(LEAD_SOURCES, contactIdx),
				AccountId: account.Id,
				OwnerId: owner.Id,
				MailingStreet: account.BillingStreet,
				MailingCity: account.BillingCity,
				MailingState: account.BillingState,
				MailingPostalCode: account.BillingPostalCode,
				MailingCountry: 'USA',
				DoNotCall: false,
				HasOptedOutOfEmail: false,
				CreatedDate: new Date(2024, contactIdx % 12, 1 + (contactIdx % 27)).toISOString(),
				LastModifiedDate: new Date(2025, contactIdx % 12, 1 + (contactIdx % 27)).toISOString(),
			});
			contactIdx++;
		}
	}

	const OPPORTUNITIES = [];
	for (let ai = 0; ai < ACCOUNTS.length; ai++) {
		const account = ACCOUNTS[ai];
		const oppCount = 1 + (ai % 3); // 1, 2, or 3 opps per account
		for (let oi = 0; oi < oppCount; oi++) {
			const idx = OPPORTUNITIES.length;
			const owner = pick(USERS, idx);
			const stage = pick(OPP_STAGES, idx);
			const amount = 10_000 + ((idx * 7_300) % 500_000);
			const probability = stage === 'Closed Won' ? 100 : stage === 'Closed Lost' ? 0 : 10 + ((idx * 13) % 80);
			const closeDate = new Date(2025, idx % 12, 1 + (idx % 27));
			const fcIdx =
				stage === 'Closed Won' || stage === 'Closed Lost'
					? 3
					: probability >= 70
						? 2
						: probability >= 40
							? 1
							: 0;
			OPPORTUNITIES.push({
				Id: mockId('006', idx + 1),
				Name:
					account.Name +
					' - ' +
					pick(['Q1 Expansion', 'Renewal', 'Pilot', 'Enterprise Deal', 'Add-on', 'Migration'], idx),
				StageName: stage,
				Amount: amount,
				ExpectedRevenue: Math.round(amount * (probability / 100)),
				Probability: probability,
				CloseDate: closeDate.toISOString().slice(0, 10),
				AccountId: account.Id,
				OwnerId: owner.Id,
				Type: pick(['New Business', 'Existing Business'], idx),
				LeadSource: pick(LEAD_SOURCES, idx),
				NextStep: pick(
					['Schedule demo', 'Send proposal', 'Negotiate terms', 'Get exec sign-off', 'Close paperwork'],
					idx,
				),
				ForecastCategory: FORECAST_CATEGORIES[fcIdx],
				ForecastCategoryName: FORECAST_CATEGORY_NAMES[fcIdx],
				HasOpportunityLineItem: false,
				IsClosed: stage === 'Closed Won' || stage === 'Closed Lost',
				IsWon: stage === 'Closed Won',
				IsPrivate: false,
				FiscalQuarter: Math.floor(closeDate.getMonth() / 3) + 1,
				FiscalYear: closeDate.getFullYear(),
				CreatedDate: new Date(2024, idx % 12, 1 + (idx % 27)).toISOString(),
				LastModifiedDate: new Date(2025, idx % 12, 1 + (idx % 27)).toISOString(),
			});
		}
	}

	const LEADS = [];
	for (let li = 0; li < 30; li++) {
		const first = pick(FIRST_NAMES, li * 3);
		const last = pick(LAST_NAMES, li * 5);
		const owner = pick(USERS, li);
		const leadCity = pick(
			['San Francisco', 'New York', 'Austin', 'Chicago', 'Seattle', 'Boston', 'Denver', 'Atlanta'],
			li,
		);
		const leadState = pick(['CA', 'NY', 'TX', 'IL', 'WA', 'MA', 'CO', 'GA'], li);
		const leadCompany = pick(COMPANY_NAMES, li * 2).replace(/\s*\(Demo\)\s*$/i, '') + ' Prospect (Demo)';
		LEADS.push({
			Id: mockId('00Q', li + 1),
			Salutation: pick(SALUTATIONS, li),
			FirstName: first,
			LastName: last,
			Name: first + ' ' + last,
			Email: (first + '.' + last).toLowerCase() + '@lead' + (li + 1) + '.example.com',
			Phone: '(212) 555-' + String(100 + li).padStart(4, '0'),
			MobilePhone: '(646) 555-' + String(100 + li).padStart(4, '0'),
			Website: 'https://' + companySlug(leadCompany) + '.example.com',
			Company: leadCompany,
			Title: pick(['CEO', 'Founder', 'VP', 'Director', 'Manager'], li),
			Status: pick(LEAD_STATUSES, li),
			LeadSource: pick(LEAD_SOURCES, li),
			Industry: pick(INDUSTRIES, li),
			Rating: pick(RATINGS, li),
			NumberOfEmployees: 5 + ((li * 23) % 1000),
			AnnualRevenue: 500_000 + ((li * 113_000) % 20_000_000),
			Street:
				String(100 + ((li * 17) % 9000)) + ' ' + pick(['Market', 'Main', 'Mission', 'Oak', 'Elm'], li) + ' St',
			City: leadCity,
			State: leadState,
			PostalCode: String(94000 + ((li * 137) % 5000)),
			Country: 'USA',
			Description: 'Inbound lead from ' + pick(LEAD_SOURCES, li).toLowerCase() + '.',
			OwnerId: owner.Id,
			DoNotCall: false,
			HasOptedOutOfEmail: false,
			IsConverted: false,
			IsUnreadByOwner: li % 4 === 0,
			CreatedDate: new Date(2024, li % 12, 1 + (li % 27)).toISOString(),
			LastModifiedDate: new Date(2025, li % 12, 1 + (li % 27)).toISOString(),
		});
	}

	function isoDate(year, monthIdx, day) {
		return new Date(year, monthIdx, day).toISOString();
	}

	const CASES = [];
	for (let i = 0; i < 30; i++) {
		const acct = ACCOUNTS[i % 15];
		const contact = CONTACTS.find((c) => c.AccountId === acct.Id) || null;
		const owner = pick(USERS, i);
		const status = pick(CASE_STATUSES, i);
		CASES.push({
			Id: mockId('500', i + 1),
			CaseNumber: String(1000 + i).padStart(8, '0'),
			Subject: pick(
				[
					'Login issue after SSO change',
					'Cannot install desktop client',
					'Feature request: dark mode',
					'Data export error on large query',
					'Permissions question',
				],
				i,
			),
			Status: status,
			Priority: pick(CASE_PRIORITIES, i),
			Origin: pick(CASE_ORIGINS, i),
			Type: pick(CASE_TYPES, i),
			Reason: pick(CASE_REASONS, i),
			AccountId: acct.Id,
			ContactId: contact ? contact.Id : null,
			OwnerId: owner.Id,
			Description: 'Customer reports an issue with the product. Needs follow-up from support.',
			IsClosed: status === 'Closed',
			IsEscalated: status === 'Escalated',
			CreatedDate: isoDate(2024, i % 12, 1 + (i % 27)),
			LastModifiedDate: isoDate(2025, i % 12, 1 + (i % 27)),
		});
	}

	const TASKS = [];
	for (let i = 0; i < 50; i++) {
		const acct = ACCOUNTS[i % ACCOUNTS.length];
		const contact = CONTACTS[i % CONTACTS.length];
		const owner = pick(USERS, i);
		const status = pick(TASK_STATUSES, i);
		const priority = pick(TASK_PRIORITIES, i);
		const subject = pick(TASK_SUBJECTS, i);
		TASKS.push({
			Id: mockId('00T', i + 1),
			Subject: subject + ': follow up on ' + acct.Name,
			Status: status,
			Priority: priority,
			ActivityDate: new Date(2025, i % 12, 1 + (i % 27)).toISOString().slice(0, 10),
			WhatId: i % 3 === 0 ? null : acct.Id,
			WhoId: contact.Id,
			OwnerId: owner.Id,
			Description: 'Outreach to keep the deal moving forward.',
			IsClosed: status === 'Completed' || status === 'Deferred',
			IsHighPriority: priority === 'High',
			IsRecurrence: false,
			IsReminderSet: false,
			CallType: subject === 'Call' ? 'Outbound' : null,
			CreatedDate: isoDate(2024, i % 12, 1 + (i % 27)),
			LastModifiedDate: isoDate(2025, i % 12, 1 + (i % 27)),
		});
	}

	const EVENTS = [];
	for (let i = 0; i < 20; i++) {
		const acct = ACCOUNTS[i % 15];
		const contact = CONTACTS.find((c) => c.AccountId === acct.Id) || CONTACTS[i];
		const owner = pick(USERS, i);
		const start = new Date(2025, i % 12, 1 + (i % 27), 10 + (i % 6), 0);
		const end = new Date(start.getTime() + 60 * 60 * 1000);
		const subject = pick(EVENT_SUBJECTS, i);
		EVENTS.push({
			Id: mockId('00U', i + 1),
			Subject: subject + ' with ' + acct.Name,
			Location: pick(['Zoom', 'Customer HQ', 'Our office', 'Phone', 'Trade show floor'], i),
			ActivityDate: start.toISOString().slice(0, 10),
			ActivityDateTime: start.toISOString(),
			StartDateTime: start.toISOString(),
			EndDateTime: end.toISOString(),
			DurationInMinutes: 60,
			WhatId: acct.Id,
			WhoId: contact.Id,
			OwnerId: owner.Id,
			Description: 'Sync with the account team.',
			IsAllDayEvent: false,
			IsPrivate: false,
			ShowAs: 'Busy',
			CreatedDate: isoDate(2024, i % 12, 1 + (i % 27)),
			LastModifiedDate: isoDate(2025, i % 12, 1 + (i % 27)),
		});
	}

	const CAMPAIGNS = [
		{ name: 'Spring Webinar Series 2025', type: 'Webinar', cost: 5000, expected: 50_000 },
		{ name: 'Q1 Email Nurture', type: 'Email', cost: 1500, expected: 25_000 },
		{ name: 'Dreamforce 2024 Booth', type: 'Conference', cost: 75_000, expected: 500_000 },
		{ name: 'Partner Referral Program 2025', type: 'Partners', cost: 10_000, expected: 100_000 },
		{ name: 'Cold Outreach: North America', type: 'Telemarketing', cost: 8_000, expected: 60_000 },
	].map((c, i) => {
		const owner = pick(USERS, i);
		const start = new Date(2024 + (i % 2), (i * 2) % 12, 1);
		const end = new Date(start.getTime() + 90 * 24 * 60 * 60 * 1000);
		return {
			Id: mockId('701', i + 1),
			Name: c.name,
			Type: c.type,
			Status: pick(CAMPAIGN_STATUSES, i),
			StartDate: start.toISOString().slice(0, 10),
			EndDate: end.toISOString().slice(0, 10),
			BudgetedCost: c.cost,
			ActualCost: Math.round(c.cost * (0.8 + i * 0.05)),
			ExpectedRevenue: c.expected,
			ExpectedResponse: 5 + i * 2,
			NumberSent: 1000 * (i + 1),
			IsActive: pick(CAMPAIGN_STATUSES, i) !== 'Aborted',
			OwnerId: owner.Id,
			Description: c.type + ' campaign targeting demand-gen in the technology vertical.',
			CreatedDate: isoDate(2024, (i * 2) % 12, 1),
			LastModifiedDate: isoDate(2025, (i * 2) % 12, 1),
		};
	});

	const CAMPAIGN_MEMBERS = [];
	for (let i = 0; i < 30; i++) {
		const campaign = CAMPAIGNS[i % CAMPAIGNS.length];
		const asLead = i % 2 === 0;
		const lead = LEADS[i % LEADS.length];
		const contact = CONTACTS[i % CONTACTS.length];
		const status = pick(CAMPAIGN_MEMBER_STATUSES, i);
		CAMPAIGN_MEMBERS.push({
			Id: mockId('00v', i + 1),
			CampaignId: campaign.Id,
			LeadId: asLead ? lead.Id : null,
			ContactId: asLead ? null : contact.Id,
			Status: status,
			HasResponded: status === 'Responded',
			FirstRespondedDate:
				status === 'Responded' ? new Date(2025, i % 12, 1 + (i % 27)).toISOString().slice(0, 10) : null,
			CreatedDate: isoDate(2024, i % 12, 1 + (i % 27)),
			LastModifiedDate: isoDate(2025, i % 12, 1 + (i % 27)),
		});
	}

	const PRODUCTS = [
		{ name: 'Platform: Starter', family: 'Software', sku: 'PLT-STR' },
		{ name: 'Platform: Pro', family: 'Software', sku: 'PLT-PRO' },
		{ name: 'Platform: Enterprise', family: 'Software', sku: 'PLT-ENT' },
		{ name: 'Mobile App Add-on', family: 'Software', sku: 'MOB-ADD' },
		{ name: 'Integration Hub', family: 'Software', sku: 'INT-HUB' },
		{ name: 'Onsite Server Appliance', family: 'Hardware', sku: 'HW-APP-01' },
		{ name: 'Implementation Services', family: 'Services', sku: 'SVC-IMPL' },
		{ name: 'Training Bundle', family: 'Services', sku: 'SVC-TRN' },
		{ name: 'Premier Support', family: 'Support', sku: 'SUP-PREM' },
		{ name: 'Standard Support', family: 'Support', sku: 'SUP-STD' },
	].map((p, i) => ({
		Id: mockId('01t', i + 1),
		Name: p.name,
		ProductCode: p.sku,
		Family: p.family,
		Description: p.family + ' product in the standard catalog.',
		IsActive: true,
		QuantityUnitOfMeasure: p.family === 'Software' ? 'License' : p.family === 'Hardware' ? 'Unit' : 'Hour',
		CreatedDate: isoDate(2024, 0, 1),
		LastModifiedDate: isoDate(2025, 0, 1),
	}));

	const PRICEBOOKS = [
		{
			Id: mockId('01s', 1),
			Name: 'Standard Price Book',
			Description: 'The default pricebook every org gets.',
			IsActive: true,
			IsStandard: true,
			IsArchived: false,
			CreatedDate: isoDate(2024, 0, 1),
			LastModifiedDate: isoDate(2024, 0, 1),
		},
	];

	const PRICEBOOK_PRICES = [499, 999, 2999, 199, 599, 4999, 12_500, 2_500, 1_200, 600];
	const PRICEBOOK_ENTRIES = PRODUCTS.map((p, i) => ({
		Id: mockId('01u', i + 1),
		Name: p.Name,
		Pricebook2Id: PRICEBOOKS[0].Id,
		Product2Id: p.Id,
		ProductCode: p.ProductCode,
		UnitPrice: PRICEBOOK_PRICES[i],
		IsActive: true,
		UseStandardPrice: true,
		CreatedDate: isoDate(2024, 0, 1),
		LastModifiedDate: isoDate(2025, 0, 1),
	}));

	const OPP_LINE_ITEMS = [];
	OPPORTUNITIES.forEach((opp, oi) => {
		const itemCount = 1 + (oi % 3);
		for (let k = 0; k < itemCount; k++) {
			const pbe = PRICEBOOK_ENTRIES[(oi + k) % PRICEBOOK_ENTRIES.length];
			const quantity = 1 + ((oi + k) % 10);
			const idx = OPP_LINE_ITEMS.length;
			OPP_LINE_ITEMS.push({
				Id: mockId('00k', idx + 1),
				OpportunityId: opp.Id,
				PricebookEntryId: pbe.Id,
				Product2Id: pbe.Product2Id,
				Quantity: quantity,
				UnitPrice: pbe.UnitPrice,
				TotalPrice: pbe.UnitPrice * quantity,
				ListPrice: pbe.UnitPrice,
				Discount: 0,
				ServiceDate: opp.CloseDate,
				Description: null,
				CreatedDate: opp.CreatedDate,
				LastModifiedDate: opp.LastModifiedDate,
			});
		}
	});

	const CONTRACTS = [];
	for (let i = 0; i < 10; i++) {
		const acct = ACCOUNTS[i];
		const owner = pick(USERS, i);
		const start = new Date(2024, i % 12, 1);
		const term = 12 + (i % 4) * 6;
		const end = new Date(start.getFullYear(), start.getMonth() + term, start.getDate());
		CONTRACTS.push({
			Id: mockId('800', i + 1),
			ContractNumber: String(2000 + i).padStart(8, '0'),
			AccountId: acct.Id,
			OwnerId: owner.Id,
			Status: pick(CONTRACT_STATUSES, i),
			StartDate: start.toISOString().slice(0, 10),
			EndDate: end.toISOString().slice(0, 10),
			ContractTerm: term,
			BillingStreet: acct.BillingStreet,
			BillingCity: acct.BillingCity,
			BillingState: acct.BillingState,
			BillingPostalCode: acct.BillingPostalCode,
			BillingCountry: acct.BillingCountry,
			Description: 'Master subscription agreement.',
			SpecialTerms: 'Standard payment terms net-30.',
			CreatedDate: isoDate(2024, i % 12, 1),
			LastModifiedDate: isoDate(2025, i % 12, 1),
		});
	}

	const ORDERS = [];
	for (let i = 0; i < 15; i++) {
		const acct = ACCOUNTS[i % 15];
		const contract = i < CONTRACTS.length ? CONTRACTS[i] : null;
		const opp = OPPORTUNITIES[i % OPPORTUNITIES.length];
		const owner = pick(USERS, i);
		const eff = new Date(2025, i % 12, 1);
		ORDERS.push({
			Id: mockId('801', i + 1),
			OrderNumber: String(3000 + i).padStart(8, '0'),
			AccountId: acct.Id,
			ContractId: contract ? contract.Id : null,
			OpportunityId: opp.Id,
			Pricebook2Id: PRICEBOOKS[0].Id,
			OwnerId: owner.Id,
			Status: pick(ORDER_STATUSES, i),
			Type: pick(ORDER_TYPES, i),
			EffectiveDate: eff.toISOString().slice(0, 10),
			EndDate: new Date(eff.getFullYear() + 1, eff.getMonth(), eff.getDate()).toISOString().slice(0, 10),
			BillingStreet: acct.BillingStreet,
			BillingCity: acct.BillingCity,
			BillingState: acct.BillingState,
			BillingPostalCode: acct.BillingPostalCode,
			BillingCountry: acct.BillingCountry,
			ShippingStreet: acct.ShippingStreet,
			ShippingCity: acct.ShippingCity,
			ShippingState: acct.ShippingState,
			ShippingPostalCode: acct.ShippingPostalCode,
			ShippingCountry: acct.ShippingCountry,
			TotalAmount: 5_000 + ((i * 1_300) % 50_000),
			Description: 'Annual subscription order.',
			CreatedDate: isoDate(2024, i % 12, 1),
			LastModifiedDate: isoDate(2025, i % 12, 1),
		});
	}

	const ORDER_ITEMS = [];
	ORDERS.forEach((ord, oi) => {
		const count = 1 + (oi % 3);
		for (let k = 0; k < count; k++) {
			const pbe = PRICEBOOK_ENTRIES[(oi + k) % PRICEBOOK_ENTRIES.length];
			const quantity = 1 + ((oi + k) % 8);
			const idx = ORDER_ITEMS.length;
			ORDER_ITEMS.push({
				Id: mockId('802', idx + 1),
				OrderId: ord.Id,
				Product2Id: pbe.Product2Id,
				PricebookEntryId: pbe.Id,
				Quantity: quantity,
				UnitPrice: pbe.UnitPrice,
				TotalPrice: pbe.UnitPrice * quantity,
				ListPrice: pbe.UnitPrice,
				ServiceDate: ord.EffectiveDate,
				Description: null,
				CreatedDate: ord.CreatedDate,
				LastModifiedDate: ord.LastModifiedDate,
			});
		}
	});

	const QUOTES = [];
	for (let i = 0; i < 10; i++) {
		const opp = OPPORTUNITIES[i];
		const acct = ACCOUNTS.find((a) => a.Id === opp.AccountId) || ACCOUNTS[0];
		const contact = CONTACTS.find((c) => c.AccountId === acct.Id) || CONTACTS[0];
		const owner = pick(USERS, i);
		const subtotal = opp.Amount;
		const discount = (i % 5) * 0.02;
		const tax = subtotal * 0.08;
		QUOTES.push({
			Id: mockId('0Q0', i + 1),
			QuoteNumber: String(4000 + i).padStart(8, '0'),
			Name: opp.Name + ': Quote v' + (1 + (i % 3)),
			OpportunityId: opp.Id,
			AccountId: acct.Id,
			ContactId: contact.Id,
			Pricebook2Id: PRICEBOOKS[0].Id,
			OwnerId: owner.Id,
			Status: pick(QUOTE_STATUSES, i),
			ExpirationDate: new Date(2025, (i % 12) + 1, 1).toISOString().slice(0, 10),
			Subtotal: subtotal,
			Discount: discount * 100,
			TotalPrice: subtotal * (1 - discount),
			Tax: tax,
			ShippingHandling: 250,
			GrandTotal: subtotal * (1 - discount) + tax + 250,
			BillingStreet: acct.BillingStreet,
			BillingCity: acct.BillingCity,
			BillingState: acct.BillingState,
			BillingPostalCode: acct.BillingPostalCode,
			BillingCountry: acct.BillingCountry,
			Description: 'Standard quote generated from the opportunity.',
			CreatedDate: isoDate(2024, i % 12, 1 + (i % 27)),
			LastModifiedDate: isoDate(2025, i % 12, 1 + (i % 27)),
		});
	}

	const QUOTE_LINE_ITEMS = [];
	QUOTES.forEach((q, qi) => {
		const count = 2 + (qi % 2);
		for (let k = 0; k < count; k++) {
			const pbe = PRICEBOOK_ENTRIES[(qi + k) % PRICEBOOK_ENTRIES.length];
			const quantity = 1 + ((qi + k) % 5);
			const idx = QUOTE_LINE_ITEMS.length;
			QUOTE_LINE_ITEMS.push({
				Id: mockId('0QL', idx + 1),
				QuoteId: q.Id,
				PricebookEntryId: pbe.Id,
				Product2Id: pbe.Product2Id,
				Quantity: quantity,
				UnitPrice: pbe.UnitPrice,
				TotalPrice: pbe.UnitPrice * quantity,
				ListPrice: pbe.UnitPrice,
				Discount: 0,
				ServiceDate: q.ExpirationDate,
				Description: null,
				CreatedDate: q.CreatedDate,
				LastModifiedDate: q.LastModifiedDate,
			});
		}
	});

	const ASSETS = [];
	for (let i = 0; i < 15; i++) {
		const acct = ACCOUNTS[i % 15];
		const contact = CONTACTS.find((c) => c.AccountId === acct.Id) || null;
		const product = PRODUCTS[i % PRODUCTS.length];
		const installDate = new Date(2024, i % 12, 1 + (i % 27));
		ASSETS.push({
			Id: mockId('02i', i + 1),
			Name: product.Name + ' for ' + acct.Name,
			SerialNumber: 'SN-' + String(10000 + i).padStart(6, '0'),
			AccountId: acct.Id,
			ContactId: contact ? contact.Id : null,
			Product2Id: product.Id,
			Status: pick(ASSET_STATUSES, i),
			Quantity: 1 + (i % 5),
			Price: PRICEBOOK_PRICES[i % PRICEBOOK_PRICES.length],
			PurchaseDate: installDate.toISOString().slice(0, 10),
			InstallDate: installDate.toISOString().slice(0, 10),
			UsageEndDate: new Date(installDate.getFullYear() + 1, installDate.getMonth(), installDate.getDate())
				.toISOString()
				.slice(0, 10),
			Description: 'Customer asset for ' + product.Name + '.',
			CreatedDate: isoDate(2024, i % 12, 1 + (i % 27)),
			LastModifiedDate: isoDate(2025, i % 12, 1 + (i % 27)),
		});
	}

	function field(opts) {
		return Object.assign(
			{
				label: opts.name,
				type: 'string',
				// Browse Records uses the same explicit capability flag as live Salesforce describes.
				filterable:
					!['base64', 'address', 'location', 'anyType', 'complexvalue', 'encryptedstring'].includes(
						opts.type,
					) && !(opts.type === 'textarea' && opts.length > 255),
				length: 255,
				nameField: false,
				updateable: true,
				createable: true,
				nillable: true,
				defaultValue: null,
				picklistValues: [],
				referenceTo: [],
				relationshipName: null,
				helpText: null,
				calculated: false,
				autoNumber: false,
				required: false,
			},
			opts,
		);
	}

	const ACCOUNT_DESCRIBE = {
		name: 'Account',
		label: 'Account',
		labelPlural: 'Accounts',
		keyPrefix: '001',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Name',
				label: 'Account Name',
				type: 'string',
				length: 255,
				nameField: true,
				nillable: false,
				required: true,
			}),
			field({ name: 'AccountNumber', label: 'Account Number', type: 'string', length: 40 }),
			field({
				name: 'Industry',
				type: 'picklist',
				length: 40,
				picklistValues: INDUSTRIES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'Type',
				label: 'Account Type',
				type: 'picklist',
				length: 40,
				picklistValues: ACCOUNT_TYPES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'Rating',
				type: 'picklist',
				length: 40,
				picklistValues: RATINGS.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'Ownership',
				type: 'picklist',
				length: 40,
				picklistValues: OWNERSHIPS.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'AccountSource',
				label: 'Account Source',
				type: 'picklist',
				length: 40,
				picklistValues: ACCOUNT_SOURCES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({ name: 'Phone', label: 'Account Phone', type: 'phone', length: 40 }),
			field({ name: 'Fax', type: 'phone', length: 40 }),
			field({ name: 'Website', type: 'url', length: 255 }),
			field({
				name: 'AnnualRevenue',
				label: 'Annual Revenue',
				type: 'currency',
				length: 18,
				precision: 18,
				scale: 0,
			}),
			field({ name: 'NumberOfEmployees', label: 'Employees', type: 'int', length: 8 }),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
				updateable: true,
				createable: true,
			}),
			field({
				name: 'ParentId',
				label: 'Parent Account ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account'],
				relationshipName: 'Parent',
			}),
			field({ name: 'BillingStreet', label: 'Billing Street', type: 'textarea', length: 255 }),
			field({ name: 'BillingCity', label: 'Billing City', type: 'string', length: 80 }),
			field({ name: 'BillingState', label: 'Billing State/Province', type: 'string', length: 80 }),
			field({ name: 'BillingPostalCode', label: 'Billing Zip/Postal Code', type: 'string', length: 20 }),
			field({ name: 'BillingCountry', label: 'Billing Country', type: 'string', length: 80 }),
			field({ name: 'ShippingStreet', label: 'Shipping Street', type: 'textarea', length: 255 }),
			field({ name: 'ShippingCity', label: 'Shipping City', type: 'string', length: 80 }),
			field({ name: 'ShippingState', label: 'Shipping State/Province', type: 'string', length: 80 }),
			field({ name: 'ShippingPostalCode', label: 'Shipping Zip/Postal Code', type: 'string', length: 20 }),
			field({ name: 'ShippingCountry', label: 'Shipping Country', type: 'string', length: 80 }),
			field({ name: 'Description', label: 'Account Description', type: 'textarea', length: 32000 }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [
			{ recordTypeId: '012000000000000AAA', name: 'Master', defaultRecordTypeMapping: true, available: true },
		],
		childRelationships: [
			{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' },
			{ childSObject: 'Opportunity', field: 'AccountId', relationshipName: 'Opportunities' },
			{ childSObject: 'Account', field: 'ParentId', relationshipName: 'ChildAccounts' },
			{ childSObject: 'Case', field: 'AccountId', relationshipName: 'Cases' },
			{ childSObject: 'Contract', field: 'AccountId', relationshipName: 'Contracts' },
			{ childSObject: 'Order', field: 'AccountId', relationshipName: 'Orders' },
			{ childSObject: 'Asset', field: 'AccountId', relationshipName: 'Assets' },
		],
	};

	const CONTACT_DESCRIBE = {
		name: 'Contact',
		label: 'Contact',
		labelPlural: 'Contacts',
		keyPrefix: '003',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Salutation',
				type: 'picklist',
				length: 40,
				picklistValues: SALUTATIONS.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({ name: 'FirstName', label: 'First Name', type: 'string', length: 40 }),
			field({
				name: 'LastName',
				label: 'Last Name',
				type: 'string',
				length: 80,
				nillable: false,
				required: true,
			}),
			field({
				name: 'Name',
				label: 'Full Name',
				type: 'string',
				length: 121,
				nameField: true,
				calculated: true,
				updateable: false,
				createable: false,
			}),
			field({ name: 'Email', type: 'email', length: 80 }),
			field({ name: 'Phone', label: 'Business Phone', type: 'phone', length: 40 }),
			field({ name: 'MobilePhone', label: 'Mobile Phone', type: 'phone', length: 40 }),
			field({ name: 'HomePhone', label: 'Home Phone', type: 'phone', length: 40 }),
			field({ name: 'OtherPhone', label: 'Other Phone', type: 'phone', length: 40 }),
			field({ name: 'Fax', type: 'phone', length: 40 }),
			field({ name: 'Title', type: 'string', length: 128 }),
			field({ name: 'Department', type: 'string', length: 80 }),
			field({
				name: 'LeadSource',
				label: 'Lead Source',
				type: 'picklist',
				length: 40,
				picklistValues: LEAD_SOURCES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({ name: 'Birthdate', type: 'date' }),
			field({
				name: 'AccountId',
				label: 'Account ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account'],
				relationshipName: 'Account',
			}),
			field({
				name: 'ReportsToId',
				label: 'Reports To ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Contact'],
				relationshipName: 'ReportsTo',
			}),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
				updateable: true,
				createable: true,
			}),
			field({ name: 'MailingStreet', label: 'Mailing Street', type: 'textarea', length: 255 }),
			field({ name: 'MailingCity', label: 'Mailing City', type: 'string', length: 80 }),
			field({ name: 'MailingState', label: 'Mailing State/Province', type: 'string', length: 80 }),
			field({ name: 'MailingPostalCode', label: 'Mailing Zip/Postal Code', type: 'string', length: 20 }),
			field({ name: 'MailingCountry', label: 'Mailing Country', type: 'string', length: 80 }),
			field({ name: 'Description', label: 'Contact Description', type: 'textarea', length: 32000 }),
			field({ name: 'DoNotCall', label: 'Do Not Call', type: 'boolean' }),
			field({ name: 'HasOptedOutOfEmail', label: 'Email Opt Out', type: 'boolean' }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [
			{ recordTypeId: '012000000000001AAA', name: 'Master', defaultRecordTypeMapping: true, available: true },
		],
		childRelationships: [
			{ childSObject: 'Contact', field: 'ReportsToId', relationshipName: 'DirectReports' },
			{ childSObject: 'Case', field: 'ContactId', relationshipName: 'Cases' },
			{ childSObject: 'CampaignMember', field: 'ContactId', relationshipName: 'CampaignMembers' },
			{ childSObject: 'Asset', field: 'ContactId', relationshipName: 'Assets' },
		],
	};

	const OPPORTUNITY_DESCRIBE = {
		name: 'Opportunity',
		label: 'Opportunity',
		labelPlural: 'Opportunities',
		keyPrefix: '006',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Name',
				label: 'Opportunity Name',
				type: 'string',
				length: 120,
				nameField: true,
				nillable: false,
				required: true,
			}),
			field({
				name: 'StageName',
				label: 'Stage',
				type: 'picklist',
				length: 40,
				nillable: false,
				required: true,
				picklistValues: OPP_STAGES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'Prospecting',
				})),
			}),
			field({ name: 'Amount', type: 'currency', length: 18, precision: 18, scale: 2 }),
			field({
				name: 'ExpectedRevenue',
				label: 'Expected Revenue',
				type: 'currency',
				length: 18,
				precision: 18,
				scale: 2,
				calculated: true,
				updateable: false,
				createable: false,
			}),
			field({
				name: 'Probability',
				label: 'Probability (%)',
				type: 'percent',
				length: 18,
				precision: 3,
				scale: 0,
			}),
			field({ name: 'CloseDate', label: 'Close Date', type: 'date', nillable: false, required: true }),
			field({
				name: 'AccountId',
				label: 'Account ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account'],
				relationshipName: 'Account',
			}),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
				updateable: true,
				createable: true,
			}),
			field({
				name: 'Type',
				label: 'Opportunity Type',
				type: 'picklist',
				length: 40,
				picklistValues: [
					{ value: 'New Business', label: 'New Business', active: true, defaultValue: false },
					{ value: 'Existing Business', label: 'Existing Business', active: true, defaultValue: false },
				],
			}),
			field({
				name: 'LeadSource',
				label: 'Lead Source',
				type: 'picklist',
				length: 40,
				picklistValues: LEAD_SOURCES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({ name: 'NextStep', label: 'Next Step', type: 'string', length: 255 }),
			field({ name: 'Description', type: 'textarea', length: 32000 }),
			field({
				name: 'ForecastCategory',
				label: 'Forecast Category',
				type: 'picklist',
				length: 40,
				updateable: false,
				createable: false,
				picklistValues: FORECAST_CATEGORIES.map((v, i) => ({
					value: v,
					label: FORECAST_CATEGORY_NAMES[i],
					active: true,
					defaultValue: false,
				})),
			}),
			field({
				name: 'ForecastCategoryName',
				label: 'Forecast Category Name',
				type: 'picklist',
				length: 40,
				picklistValues: FORECAST_CATEGORY_NAMES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: false,
				})),
			}),
			field({
				name: 'HasOpportunityLineItem',
				label: 'Has Line Item',
				type: 'boolean',
				updateable: false,
				createable: false,
			}),
			field({ name: 'IsClosed', label: 'Closed', type: 'boolean', updateable: false, createable: false }),
			field({ name: 'IsWon', label: 'Won', type: 'boolean', updateable: false, createable: false }),
			field({ name: 'IsPrivate', label: 'Private', type: 'boolean' }),
			field({
				name: 'FiscalQuarter',
				label: 'Fiscal Quarter',
				type: 'int',
				updateable: false,
				createable: false,
			}),
			field({ name: 'FiscalYear', label: 'Fiscal Year', type: 'int', updateable: false, createable: false }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [
			{ recordTypeId: '012000000000002AAA', name: 'Master', defaultRecordTypeMapping: true, available: true },
		],
		childRelationships: [
			{ childSObject: 'OpportunityLineItem', field: 'OpportunityId', relationshipName: 'OpportunityLineItems' },
			{ childSObject: 'Quote', field: 'OpportunityId', relationshipName: 'Quotes' },
			{ childSObject: 'Order', field: 'OpportunityId', relationshipName: 'Orders' },
		],
	};

	const LEAD_DESCRIBE = {
		name: 'Lead',
		label: 'Lead',
		labelPlural: 'Leads',
		keyPrefix: '00Q',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Salutation',
				type: 'picklist',
				length: 40,
				picklistValues: SALUTATIONS.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({ name: 'FirstName', label: 'First Name', type: 'string', length: 40 }),
			field({
				name: 'LastName',
				label: 'Last Name',
				type: 'string',
				length: 80,
				nillable: false,
				required: true,
			}),
			field({
				name: 'Name',
				label: 'Full Name',
				type: 'string',
				length: 121,
				nameField: true,
				calculated: true,
				updateable: false,
				createable: false,
			}),
			field({ name: 'Company', type: 'string', length: 255, nillable: false, required: true }),
			field({ name: 'Title', type: 'string', length: 128 }),
			field({ name: 'Email', type: 'email', length: 80 }),
			field({ name: 'Phone', label: 'Business Phone', type: 'phone', length: 40 }),
			field({ name: 'MobilePhone', label: 'Mobile Phone', type: 'phone', length: 40 }),
			field({ name: 'Fax', type: 'phone', length: 40 }),
			field({ name: 'Website', type: 'url', length: 255 }),
			field({
				name: 'Status',
				label: 'Lead Status',
				type: 'picklist',
				length: 40,
				nillable: false,
				required: true,
				picklistValues: LEAD_STATUSES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'Open - Not Contacted',
				})),
			}),
			field({
				name: 'LeadSource',
				label: 'Lead Source',
				type: 'picklist',
				length: 40,
				picklistValues: LEAD_SOURCES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'Industry',
				type: 'picklist',
				length: 40,
				picklistValues: INDUSTRIES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'Rating',
				type: 'picklist',
				length: 40,
				picklistValues: RATINGS.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({ name: 'NumberOfEmployees', label: 'No. of Employees', type: 'int', length: 8 }),
			field({
				name: 'AnnualRevenue',
				label: 'Annual Revenue',
				type: 'currency',
				length: 18,
				precision: 18,
				scale: 0,
			}),
			field({ name: 'Street', type: 'textarea', length: 255 }),
			field({ name: 'City', type: 'string', length: 80 }),
			field({ name: 'State', label: 'State/Province', type: 'string', length: 80 }),
			field({ name: 'PostalCode', label: 'Zip/Postal Code', type: 'string', length: 20 }),
			field({ name: 'Country', type: 'string', length: 80 }),
			field({ name: 'Description', type: 'textarea', length: 32000 }),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
				updateable: true,
				createable: true,
			}),
			field({ name: 'DoNotCall', label: 'Do Not Call', type: 'boolean' }),
			field({ name: 'HasOptedOutOfEmail', label: 'Email Opt Out', type: 'boolean' }),
			field({ name: 'IsConverted', label: 'Converted', type: 'boolean', updateable: false, createable: false }),
			field({
				name: 'ConvertedDate',
				label: 'Converted Date',
				type: 'date',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'ConvertedAccountId',
				label: 'Converted Account ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account'],
				relationshipName: 'ConvertedAccount',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'ConvertedContactId',
				label: 'Converted Contact ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Contact'],
				relationshipName: 'ConvertedContact',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'ConvertedOpportunityId',
				label: 'Converted Opportunity ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Opportunity'],
				relationshipName: 'ConvertedOpportunity',
				updateable: false,
				createable: false,
			}),
			field({ name: 'IsUnreadByOwner', label: 'Unread By Owner', type: 'boolean' }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [
			{ recordTypeId: '012000000000003AAA', name: 'Master', defaultRecordTypeMapping: true, available: true },
		],
		childRelationships: [],
	};

	const USER_DESCRIBE = {
		name: 'User',
		label: 'User',
		labelPlural: 'Users',
		keyPrefix: '005',
		createable: false,
		updateable: false,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Username',
				type: 'string',
				length: 80,
				updateable: false,
				createable: false,
				nillable: false,
			}),
			field({
				name: 'FirstName',
				label: 'First Name',
				type: 'string',
				length: 40,
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastName',
				label: 'Last Name',
				type: 'string',
				length: 80,
				updateable: false,
				createable: false,
				nillable: false,
			}),
			field({
				name: 'Name',
				label: 'Full Name',
				type: 'string',
				length: 121,
				nameField: true,
				calculated: true,
				updateable: false,
				createable: false,
			}),
			field({ name: 'Alias', type: 'string', length: 8, updateable: false, createable: false }),
			field({ name: 'Email', type: 'email', length: 128, updateable: false, createable: false, nillable: false }),
			field({ name: 'Title', type: 'string', length: 80, updateable: false, createable: false }),
			field({ name: 'Department', type: 'string', length: 80, updateable: false, createable: false }),
			field({ name: 'Phone', type: 'phone', length: 40, updateable: false, createable: false }),
			field({ name: 'IsActive', label: 'Active', type: 'boolean', updateable: false, createable: false }),
			field({
				name: 'UserType',
				label: 'User Type',
				type: 'picklist',
				length: 40,
				picklistValues: [{ value: 'Standard', label: 'Standard', active: true, defaultValue: true }],
				updateable: false,
				createable: false,
			}),
			field({
				name: 'TimeZoneSidKey',
				label: 'Time Zone',
				type: 'picklist',
				length: 40,
				updateable: false,
				createable: false,
				picklistValues: [
					{ value: 'America/Los_Angeles', label: '(GMT-08:00) Pacific', active: true, defaultValue: true },
				],
			}),
			field({
				name: 'LocaleSidKey',
				label: 'Locale',
				type: 'picklist',
				length: 40,
				updateable: false,
				createable: false,
				picklistValues: [
					{ value: 'en_US', label: 'English (United States)', active: true, defaultValue: true },
				],
			}),
			field({
				name: 'LanguageLocaleKey',
				label: 'Language',
				type: 'picklist',
				length: 40,
				updateable: false,
				createable: false,
				picklistValues: [{ value: 'en_US', label: 'English', active: true, defaultValue: true }],
			}),
			field({
				name: 'EmailEncodingKey',
				label: 'Email Encoding',
				type: 'picklist',
				length: 40,
				updateable: false,
				createable: false,
				picklistValues: [{ value: 'UTF-8', label: 'Unicode (UTF-8)', active: true, defaultValue: true }],
			}),
			field({
				name: 'ManagerId',
				label: 'Manager ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Manager',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [],
		childRelationships: [],
	};

	const CASE_DESCRIBE = {
		name: 'Case',
		label: 'Case',
		labelPlural: 'Cases',
		keyPrefix: '500',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'CaseNumber',
				label: 'Case Number',
				type: 'string',
				length: 30,
				nameField: true,
				updateable: false,
				createable: false,
				autoNumber: true,
			}),
			field({ name: 'Subject', type: 'string', length: 255 }),
			field({
				name: 'Status',
				type: 'picklist',
				length: 40,
				nillable: false,
				required: true,
				picklistValues: CASE_STATUSES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'New',
				})),
			}),
			field({
				name: 'Priority',
				type: 'picklist',
				length: 40,
				picklistValues: CASE_PRIORITIES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'Medium',
				})),
			}),
			field({
				name: 'Origin',
				label: 'Case Origin',
				type: 'picklist',
				length: 40,
				picklistValues: CASE_ORIGINS.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'Type',
				label: 'Case Type',
				type: 'picklist',
				length: 40,
				picklistValues: CASE_TYPES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'Reason',
				label: 'Case Reason',
				type: 'picklist',
				length: 40,
				picklistValues: CASE_REASONS.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'AccountId',
				label: 'Account ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account'],
				relationshipName: 'Account',
			}),
			field({
				name: 'ContactId',
				label: 'Contact ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Contact'],
				relationshipName: 'Contact',
			}),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
				updateable: true,
				createable: true,
			}),
			field({ name: 'Description', type: 'textarea', length: 32000 }),
			field({ name: 'IsClosed', label: 'Closed', type: 'boolean', updateable: false, createable: false }),
			field({ name: 'IsEscalated', label: 'Escalated', type: 'boolean' }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [
			{ recordTypeId: '012000000000004AAA', name: 'Master', defaultRecordTypeMapping: true, available: true },
		],
		childRelationships: [],
	};

	const TASK_DESCRIBE = {
		name: 'Task',
		label: 'Task',
		labelPlural: 'Tasks',
		keyPrefix: '00T',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Subject',
				type: 'combobox',
				length: 255,
				nameField: true,
				picklistValues: TASK_SUBJECTS.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'Status',
				type: 'picklist',
				length: 40,
				nillable: false,
				required: true,
				picklistValues: TASK_STATUSES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'Not Started',
				})),
			}),
			field({
				name: 'Priority',
				type: 'picklist',
				length: 40,
				picklistValues: TASK_PRIORITIES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'Normal',
				})),
			}),
			field({ name: 'ActivityDate', label: 'Due Date', type: 'date' }),
			field({
				name: 'WhatId',
				label: 'Related To ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account', 'Opportunity', 'Case', 'Campaign', 'Contract'],
				relationshipName: 'What',
			}),
			field({
				name: 'WhoId',
				label: 'Name ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Contact', 'Lead'],
				relationshipName: 'Who',
			}),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
			}),
			field({ name: 'Description', type: 'textarea', length: 32000 }),
			field({ name: 'IsClosed', label: 'Closed', type: 'boolean', updateable: false, createable: false }),
			field({
				name: 'IsHighPriority',
				label: 'High Priority',
				type: 'boolean',
				updateable: false,
				createable: false,
			}),
			field({ name: 'IsRecurrence', label: 'Recurring', type: 'boolean' }),
			field({ name: 'IsReminderSet', label: 'Reminder Set', type: 'boolean' }),
			field({
				name: 'CallType',
				label: 'Call Type',
				type: 'picklist',
				length: 40,
				picklistValues: [
					{ value: 'Inbound', label: 'Inbound', active: true, defaultValue: false },
					{ value: 'Outbound', label: 'Outbound', active: true, defaultValue: false },
					{ value: 'Internal', label: 'Internal', active: true, defaultValue: false },
				],
			}),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [
			{ recordTypeId: '012000000000005AAA', name: 'Master', defaultRecordTypeMapping: true, available: true },
		],
		childRelationships: [],
	};

	const EVENT_DESCRIBE = {
		name: 'Event',
		label: 'Event',
		labelPlural: 'Events',
		keyPrefix: '00U',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Subject',
				type: 'combobox',
				length: 255,
				nameField: true,
				picklistValues: EVENT_SUBJECTS.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({ name: 'Location', type: 'string', length: 80 }),
			field({ name: 'ActivityDate', label: 'Date', type: 'date' }),
			field({ name: 'ActivityDateTime', label: 'Date/Time', type: 'datetime' }),
			field({ name: 'StartDateTime', label: 'Start', type: 'datetime', nillable: false, required: true }),
			field({ name: 'EndDateTime', label: 'End', type: 'datetime' }),
			field({ name: 'DurationInMinutes', label: 'Duration (min)', type: 'int' }),
			field({
				name: 'WhatId',
				label: 'Related To ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account', 'Opportunity', 'Case', 'Campaign', 'Contract'],
				relationshipName: 'What',
			}),
			field({
				name: 'WhoId',
				label: 'Name ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Contact', 'Lead'],
				relationshipName: 'Who',
			}),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
			}),
			field({ name: 'Description', type: 'textarea', length: 32000 }),
			field({ name: 'IsAllDayEvent', label: 'All-Day Event', type: 'boolean' }),
			field({ name: 'IsPrivate', label: 'Private', type: 'boolean' }),
			field({
				name: 'ShowAs',
				label: 'Show Time As',
				type: 'picklist',
				length: 40,
				picklistValues: [
					{ value: 'Busy', label: 'Busy', active: true, defaultValue: true },
					{ value: 'OutOfOffice', label: 'Out of Office', active: true, defaultValue: false },
					{ value: 'Free', label: 'Free', active: true, defaultValue: false },
				],
			}),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [
			{ recordTypeId: '012000000000006AAA', name: 'Master', defaultRecordTypeMapping: true, available: true },
		],
		childRelationships: [],
	};

	const CAMPAIGN_DESCRIBE = {
		name: 'Campaign',
		label: 'Campaign',
		labelPlural: 'Campaigns',
		keyPrefix: '701',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Name',
				label: 'Campaign Name',
				type: 'string',
				length: 80,
				nameField: true,
				nillable: false,
				required: true,
			}),
			field({
				name: 'Type',
				type: 'picklist',
				length: 40,
				picklistValues: CAMPAIGN_TYPES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({
				name: 'Status',
				type: 'picklist',
				length: 40,
				picklistValues: CAMPAIGN_STATUSES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'Planned',
				})),
			}),
			field({ name: 'StartDate', label: 'Start Date', type: 'date' }),
			field({ name: 'EndDate', label: 'End Date', type: 'date' }),
			field({ name: 'BudgetedCost', label: 'Budgeted Cost', type: 'currency', precision: 18, scale: 2 }),
			field({ name: 'ActualCost', label: 'Actual Cost', type: 'currency', precision: 18, scale: 2 }),
			field({ name: 'ExpectedRevenue', label: 'Expected Revenue', type: 'currency', precision: 18, scale: 2 }),
			field({
				name: 'ExpectedResponse',
				label: 'Expected Response (%)',
				type: 'percent',
				precision: 8,
				scale: 2,
			}),
			field({ name: 'NumberSent', label: 'Num Sent', type: 'double', precision: 18, scale: 0 }),
			field({ name: 'IsActive', label: 'Active', type: 'boolean' }),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
			}),
			field({ name: 'Description', type: 'textarea', length: 32000 }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [
			{ recordTypeId: '012000000000007AAA', name: 'Master', defaultRecordTypeMapping: true, available: true },
		],
		childRelationships: [
			{ childSObject: 'CampaignMember', field: 'CampaignId', relationshipName: 'CampaignMembers' },
		],
	};

	const CAMPAIGN_MEMBER_DESCRIBE = {
		name: 'CampaignMember',
		label: 'Campaign Member',
		labelPlural: 'Campaign Members',
		keyPrefix: '00v',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'CampaignId',
				label: 'Campaign ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Campaign'],
				relationshipName: 'Campaign',
				nillable: false,
				required: true,
			}),
			field({
				name: 'LeadId',
				label: 'Lead ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Lead'],
				relationshipName: 'Lead',
			}),
			field({
				name: 'ContactId',
				label: 'Contact ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Contact'],
				relationshipName: 'Contact',
			}),
			field({
				name: 'Status',
				type: 'picklist',
				length: 40,
				picklistValues: CAMPAIGN_MEMBER_STATUSES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'Sent',
				})),
			}),
			field({
				name: 'HasResponded',
				label: 'Has Responded',
				type: 'boolean',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'FirstRespondedDate',
				label: 'First Responded Date',
				type: 'date',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [],
		childRelationships: [],
	};

	const PRODUCT_DESCRIBE = {
		name: 'Product2',
		label: 'Product',
		labelPlural: 'Products',
		keyPrefix: '01t',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Name',
				label: 'Product Name',
				type: 'string',
				length: 255,
				nameField: true,
				nillable: false,
				required: true,
			}),
			field({ name: 'ProductCode', label: 'Product Code', type: 'string', length: 255 }),
			field({
				name: 'Family',
				label: 'Product Family',
				type: 'picklist',
				length: 40,
				picklistValues: PRODUCT_FAMILIES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: false,
				})),
			}),
			field({ name: 'Description', type: 'textarea', length: 4000 }),
			field({ name: 'IsActive', label: 'Active', type: 'boolean' }),
			field({
				name: 'QuantityUnitOfMeasure',
				label: 'Quantity Unit',
				type: 'picklist',
				length: 40,
				picklistValues: [
					{ value: 'License', label: 'License', active: true, defaultValue: false },
					{ value: 'Unit', label: 'Unit', active: true, defaultValue: false },
					{ value: 'Hour', label: 'Hour', active: true, defaultValue: false },
				],
			}),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [],
		childRelationships: [
			{ childSObject: 'PricebookEntry', field: 'Product2Id', relationshipName: 'PricebookEntries' },
			{ childSObject: 'Asset', field: 'Product2Id', relationshipName: 'Assets' },
		],
	};

	const PRICEBOOK_DESCRIBE = {
		name: 'Pricebook2',
		label: 'Price Book',
		labelPlural: 'Price Books',
		keyPrefix: '01s',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Name',
				label: 'Price Book Name',
				type: 'string',
				length: 255,
				nameField: true,
				nillable: false,
				required: true,
			}),
			field({ name: 'Description', type: 'textarea', length: 4000 }),
			field({ name: 'IsActive', label: 'Active', type: 'boolean' }),
			field({
				name: 'IsStandard',
				label: 'Standard Price Book',
				type: 'boolean',
				updateable: false,
				createable: false,
			}),
			field({ name: 'IsArchived', label: 'Archived', type: 'boolean' }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [],
		childRelationships: [
			{ childSObject: 'PricebookEntry', field: 'Pricebook2Id', relationshipName: 'PricebookEntries' },
		],
	};

	const PRICEBOOK_ENTRY_DESCRIBE = {
		name: 'PricebookEntry',
		label: 'Price Book Entry',
		labelPlural: 'Price Book Entries',
		keyPrefix: '01u',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Name',
				label: 'Product Name',
				type: 'string',
				length: 255,
				nameField: true,
				updateable: false,
				createable: false,
			}),
			field({
				name: 'Pricebook2Id',
				label: 'Price Book ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Pricebook2'],
				relationshipName: 'Pricebook2',
				nillable: false,
				required: true,
			}),
			field({
				name: 'Product2Id',
				label: 'Product ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Product2'],
				relationshipName: 'Product2',
				nillable: false,
				required: true,
			}),
			field({
				name: 'ProductCode',
				label: 'Product Code',
				type: 'string',
				length: 255,
				updateable: false,
				createable: false,
			}),
			field({
				name: 'UnitPrice',
				label: 'List Price',
				type: 'currency',
				precision: 18,
				scale: 2,
				nillable: false,
				required: true,
			}),
			field({ name: 'IsActive', label: 'Active', type: 'boolean' }),
			field({ name: 'UseStandardPrice', label: 'Use Standard Price', type: 'boolean' }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [],
		childRelationships: [],
	};

	const OPP_LINE_ITEM_DESCRIBE = {
		name: 'OpportunityLineItem',
		label: 'Opportunity Product',
		labelPlural: 'Opportunity Products',
		keyPrefix: '00k',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'OpportunityId',
				label: 'Opportunity ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Opportunity'],
				relationshipName: 'Opportunity',
				nillable: false,
				required: true,
			}),
			field({
				name: 'PricebookEntryId',
				label: 'Price Book Entry ID',
				type: 'reference',
				length: 18,
				referenceTo: ['PricebookEntry'],
				relationshipName: 'PricebookEntry',
			}),
			field({
				name: 'Product2Id',
				label: 'Product ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Product2'],
				relationshipName: 'Product2',
				updateable: false,
				createable: false,
			}),
			field({ name: 'Quantity', type: 'double', precision: 12, scale: 2, nillable: false, required: true }),
			field({ name: 'UnitPrice', label: 'Sales Price', type: 'currency', precision: 18, scale: 2 }),
			field({
				name: 'TotalPrice',
				label: 'Total Price',
				type: 'currency',
				precision: 18,
				scale: 2,
				calculated: true,
				updateable: false,
				createable: false,
			}),
			field({
				name: 'ListPrice',
				label: 'List Price',
				type: 'currency',
				precision: 18,
				scale: 2,
				updateable: false,
				createable: false,
			}),
			field({ name: 'Discount', label: 'Discount (%)', type: 'percent', precision: 8, scale: 2 }),
			field({ name: 'ServiceDate', label: 'Date', type: 'date' }),
			field({ name: 'Description', type: 'textarea', length: 255 }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [],
		childRelationships: [],
	};

	const CONTRACT_DESCRIBE = {
		name: 'Contract',
		label: 'Contract',
		labelPlural: 'Contracts',
		keyPrefix: '800',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'ContractNumber',
				label: 'Contract Number',
				type: 'string',
				length: 30,
				nameField: true,
				updateable: false,
				createable: false,
				autoNumber: true,
			}),
			field({
				name: 'AccountId',
				label: 'Account ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account'],
				relationshipName: 'Account',
				nillable: false,
				required: true,
			}),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
			}),
			field({
				name: 'Status',
				type: 'picklist',
				length: 40,
				nillable: false,
				required: true,
				picklistValues: CONTRACT_STATUSES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'Draft',
				})),
			}),
			field({ name: 'StartDate', label: 'Contract Start Date', type: 'date' }),
			field({
				name: 'EndDate',
				label: 'Contract End Date',
				type: 'date',
				updateable: false,
				createable: false,
				calculated: true,
			}),
			field({ name: 'ContractTerm', label: 'Contract Term (months)', type: 'int' }),
			field({ name: 'BillingStreet', label: 'Billing Street', type: 'textarea', length: 255 }),
			field({ name: 'BillingCity', label: 'Billing City', type: 'string', length: 80 }),
			field({ name: 'BillingState', label: 'Billing State/Province', type: 'string', length: 80 }),
			field({ name: 'BillingPostalCode', label: 'Billing Zip/Postal Code', type: 'string', length: 20 }),
			field({ name: 'BillingCountry', label: 'Billing Country', type: 'string', length: 80 }),
			field({ name: 'Description', type: 'textarea', length: 32000 }),
			field({ name: 'SpecialTerms', label: 'Special Terms', type: 'textarea', length: 32000 }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [
			{ recordTypeId: '012000000000008AAA', name: 'Master', defaultRecordTypeMapping: true, available: true },
		],
		childRelationships: [{ childSObject: 'Order', field: 'ContractId', relationshipName: 'Orders' }],
	};

	const ORDER_DESCRIBE = {
		name: 'Order',
		label: 'Order',
		labelPlural: 'Orders',
		keyPrefix: '801',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'OrderNumber',
				label: 'Order Number',
				type: 'string',
				length: 30,
				nameField: true,
				updateable: false,
				createable: false,
				autoNumber: true,
			}),
			field({
				name: 'AccountId',
				label: 'Account ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account'],
				relationshipName: 'Account',
				nillable: false,
				required: true,
			}),
			field({
				name: 'ContractId',
				label: 'Contract ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Contract'],
				relationshipName: 'Contract',
			}),
			field({
				name: 'OpportunityId',
				label: 'Opportunity ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Opportunity'],
				relationshipName: 'Opportunity',
			}),
			field({
				name: 'Pricebook2Id',
				label: 'Price Book ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Pricebook2'],
				relationshipName: 'Pricebook2',
			}),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
			}),
			field({
				name: 'Status',
				type: 'picklist',
				length: 40,
				nillable: false,
				required: true,
				picklistValues: ORDER_STATUSES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'Draft',
				})),
			}),
			field({
				name: 'Type',
				label: 'Order Type',
				type: 'picklist',
				length: 40,
				picklistValues: ORDER_TYPES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({ name: 'EffectiveDate', label: 'Order Start Date', type: 'date', nillable: false, required: true }),
			field({ name: 'EndDate', label: 'Order End Date', type: 'date' }),
			field({ name: 'BillingStreet', label: 'Billing Street', type: 'textarea', length: 255 }),
			field({ name: 'BillingCity', label: 'Billing City', type: 'string', length: 80 }),
			field({ name: 'BillingState', label: 'Billing State/Province', type: 'string', length: 80 }),
			field({ name: 'BillingPostalCode', label: 'Billing Zip/Postal Code', type: 'string', length: 20 }),
			field({ name: 'BillingCountry', label: 'Billing Country', type: 'string', length: 80 }),
			field({ name: 'ShippingStreet', label: 'Shipping Street', type: 'textarea', length: 255 }),
			field({ name: 'ShippingCity', label: 'Shipping City', type: 'string', length: 80 }),
			field({ name: 'ShippingState', label: 'Shipping State/Province', type: 'string', length: 80 }),
			field({ name: 'ShippingPostalCode', label: 'Shipping Zip/Postal Code', type: 'string', length: 20 }),
			field({ name: 'ShippingCountry', label: 'Shipping Country', type: 'string', length: 80 }),
			field({
				name: 'TotalAmount',
				label: 'Order Amount',
				type: 'currency',
				precision: 18,
				scale: 2,
				updateable: false,
				createable: false,
				calculated: true,
			}),
			field({ name: 'Description', type: 'textarea', length: 32000 }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [
			{ recordTypeId: '012000000000009AAA', name: 'Master', defaultRecordTypeMapping: true, available: true },
		],
		childRelationships: [{ childSObject: 'OrderItem', field: 'OrderId', relationshipName: 'OrderItems' }],
	};

	const ORDER_ITEM_DESCRIBE = {
		name: 'OrderItem',
		label: 'Order Product',
		labelPlural: 'Order Products',
		keyPrefix: '802',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'OrderId',
				label: 'Order ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Order'],
				relationshipName: 'Order',
				nillable: false,
				required: true,
			}),
			field({
				name: 'Product2Id',
				label: 'Product ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Product2'],
				relationshipName: 'Product2',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'PricebookEntryId',
				label: 'Price Book Entry ID',
				type: 'reference',
				length: 18,
				referenceTo: ['PricebookEntry'],
				relationshipName: 'PricebookEntry',
				nillable: false,
				required: true,
			}),
			field({ name: 'Quantity', type: 'double', precision: 12, scale: 2, nillable: false, required: true }),
			field({ name: 'UnitPrice', label: 'Unit Price', type: 'currency', precision: 18, scale: 2 }),
			field({
				name: 'TotalPrice',
				label: 'Total Price',
				type: 'currency',
				precision: 18,
				scale: 2,
				calculated: true,
				updateable: false,
				createable: false,
			}),
			field({
				name: 'ListPrice',
				label: 'List Price',
				type: 'currency',
				precision: 18,
				scale: 2,
				updateable: false,
				createable: false,
			}),
			field({ name: 'ServiceDate', label: 'Date', type: 'date' }),
			field({ name: 'Description', type: 'textarea', length: 255 }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [],
		childRelationships: [],
	};

	const QUOTE_DESCRIBE = {
		name: 'Quote',
		label: 'Quote',
		labelPlural: 'Quotes',
		keyPrefix: '0Q0',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'QuoteNumber',
				label: 'Quote Number',
				type: 'string',
				length: 30,
				updateable: false,
				createable: false,
				autoNumber: true,
			}),
			field({
				name: 'Name',
				label: 'Quote Name',
				type: 'string',
				length: 255,
				nameField: true,
				nillable: false,
				required: true,
			}),
			field({
				name: 'OpportunityId',
				label: 'Opportunity ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Opportunity'],
				relationshipName: 'Opportunity',
				nillable: false,
				required: true,
			}),
			field({
				name: 'AccountId',
				label: 'Account ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account'],
				relationshipName: 'Account',
			}),
			field({
				name: 'ContactId',
				label: 'Contact ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Contact'],
				relationshipName: 'Contact',
			}),
			field({
				name: 'Pricebook2Id',
				label: 'Price Book ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Pricebook2'],
				relationshipName: 'Pricebook2',
			}),
			field({
				name: 'OwnerId',
				label: 'Owner ID',
				type: 'reference',
				length: 18,
				referenceTo: ['User'],
				relationshipName: 'Owner',
			}),
			field({
				name: 'Status',
				type: 'picklist',
				length: 40,
				picklistValues: QUOTE_STATUSES.map((v) => ({
					value: v,
					label: v,
					active: true,
					defaultValue: v === 'Draft',
				})),
			}),
			field({ name: 'ExpirationDate', label: 'Expiration Date', type: 'date' }),
			field({
				name: 'Subtotal',
				type: 'currency',
				precision: 18,
				scale: 2,
				calculated: true,
				updateable: false,
				createable: false,
			}),
			field({ name: 'Discount', label: 'Discount (%)', type: 'percent', precision: 8, scale: 2 }),
			field({
				name: 'TotalPrice',
				label: 'Total Price',
				type: 'currency',
				precision: 18,
				scale: 2,
				calculated: true,
				updateable: false,
				createable: false,
			}),
			field({ name: 'Tax', type: 'currency', precision: 18, scale: 2 }),
			field({
				name: 'ShippingHandling',
				label: 'Shipping & Handling',
				type: 'currency',
				precision: 18,
				scale: 2,
			}),
			field({
				name: 'GrandTotal',
				label: 'Grand Total',
				type: 'currency',
				precision: 18,
				scale: 2,
				calculated: true,
				updateable: false,
				createable: false,
			}),
			field({ name: 'BillingStreet', label: 'Billing Street', type: 'textarea', length: 255 }),
			field({ name: 'BillingCity', label: 'Billing City', type: 'string', length: 80 }),
			field({ name: 'BillingState', label: 'Billing State/Province', type: 'string', length: 80 }),
			field({ name: 'BillingPostalCode', label: 'Billing Zip/Postal Code', type: 'string', length: 20 }),
			field({ name: 'BillingCountry', label: 'Billing Country', type: 'string', length: 80 }),
			field({ name: 'Description', type: 'textarea', length: 32000 }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [],
		childRelationships: [{ childSObject: 'QuoteLineItem', field: 'QuoteId', relationshipName: 'QuoteLineItems' }],
	};

	const QUOTE_LINE_ITEM_DESCRIBE = {
		name: 'QuoteLineItem',
		label: 'Quote Line Item',
		labelPlural: 'Quote Line Items',
		keyPrefix: '0QL',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'QuoteId',
				label: 'Quote ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Quote'],
				relationshipName: 'Quote',
				nillable: false,
				required: true,
			}),
			field({
				name: 'PricebookEntryId',
				label: 'Price Book Entry ID',
				type: 'reference',
				length: 18,
				referenceTo: ['PricebookEntry'],
				relationshipName: 'PricebookEntry',
				nillable: false,
				required: true,
			}),
			field({
				name: 'Product2Id',
				label: 'Product ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Product2'],
				relationshipName: 'Product2',
				updateable: false,
				createable: false,
			}),
			field({ name: 'Quantity', type: 'double', precision: 12, scale: 2, nillable: false, required: true }),
			field({ name: 'UnitPrice', label: 'Sales Price', type: 'currency', precision: 18, scale: 2 }),
			field({
				name: 'TotalPrice',
				label: 'Total Price',
				type: 'currency',
				precision: 18,
				scale: 2,
				calculated: true,
				updateable: false,
				createable: false,
			}),
			field({
				name: 'ListPrice',
				label: 'List Price',
				type: 'currency',
				precision: 18,
				scale: 2,
				updateable: false,
				createable: false,
			}),
			field({ name: 'Discount', label: 'Discount (%)', type: 'percent', precision: 8, scale: 2 }),
			field({ name: 'ServiceDate', label: 'Date', type: 'date' }),
			field({ name: 'Description', type: 'textarea', length: 255 }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [],
		childRelationships: [],
	};

	const ASSET_DESCRIBE = {
		name: 'Asset',
		label: 'Asset',
		labelPlural: 'Assets',
		keyPrefix: '02i',
		createable: true,
		updateable: true,
		queryable: true,
		fields: [
			field({ name: 'Id', type: 'id', length: 18, updateable: false, createable: false, nillable: false }),
			field({
				name: 'Name',
				label: 'Asset Name',
				type: 'string',
				length: 255,
				nameField: true,
				nillable: false,
				required: true,
			}),
			field({ name: 'SerialNumber', label: 'Serial Number', type: 'string', length: 80 }),
			field({
				name: 'AccountId',
				label: 'Account ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Account'],
				relationshipName: 'Account',
			}),
			field({
				name: 'ContactId',
				label: 'Contact ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Contact'],
				relationshipName: 'Contact',
			}),
			field({
				name: 'Product2Id',
				label: 'Product ID',
				type: 'reference',
				length: 18,
				referenceTo: ['Product2'],
				relationshipName: 'Product2',
			}),
			field({
				name: 'Status',
				type: 'picklist',
				length: 40,
				picklistValues: ASSET_STATUSES.map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
			}),
			field({ name: 'Quantity', type: 'double', precision: 18, scale: 2 }),
			field({ name: 'Price', type: 'currency', precision: 18, scale: 2 }),
			field({ name: 'PurchaseDate', label: 'Purchase Date', type: 'date' }),
			field({ name: 'InstallDate', label: 'Install Date', type: 'date' }),
			field({ name: 'UsageEndDate', label: 'Usage End Date', type: 'date' }),
			field({ name: 'Description', type: 'textarea', length: 1000 }),
			field({
				name: 'CreatedDate',
				label: 'Created Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
			field({
				name: 'LastModifiedDate',
				label: 'Last Modified Date',
				type: 'datetime',
				updateable: false,
				createable: false,
			}),
		],
		recordTypeInfos: [],
		childRelationships: [],
	};

	function c(apiName, label) {
		return { apiName, label: label || apiName, required: false, editableForNew: true, editableForUpdate: true };
	}
	function cReq(apiName, label) {
		return { apiName, label: label || apiName, required: true, editableForNew: true, editableForUpdate: true };
	}
	function cRO(apiName, label) {
		return { apiName, label: label || apiName, required: false, editableForNew: false, editableForUpdate: false };
	}
	function sec(heading, columns, rows) {
		return { heading, columns, collapsible: false, rows };
	}
	const SYSTEM_INFO_SECTION = sec('System Information', 2, [
		[cRO('CreatedDate', 'Created Date'), cRO('LastModifiedDate', 'Last Modified Date')],
	]);

	const ACCOUNT_LAYOUT = {
		columns: 2,
		sections: [
			sec('Account Information', 2, [
				[cRO('OwnerId', 'Account Owner'), c('Rating')],
				[cReq('Name', 'Account Name'), c('Phone', 'Account Phone')],
				[c('ParentId', 'Parent Account'), c('Fax')],
				[c('AccountNumber', 'Account Number'), c('Website')],
				[c('Type', 'Type'), c('Ownership')],
				[c('Industry'), c('NumberOfEmployees', 'Employees')],
				[c('AnnualRevenue', 'Annual Revenue'), c('AccountSource', 'Account Source')],
			]),
			sec('Address Information', 2, [
				[c('BillingStreet', 'Billing Street'), c('ShippingStreet', 'Shipping Street')],
				[c('BillingCity', 'Billing City'), c('ShippingCity', 'Shipping City')],
				[c('BillingState', 'Billing State/Province'), c('ShippingState', 'Shipping State/Province')],
				[
					c('BillingPostalCode', 'Billing Zip/Postal Code'),
					c('ShippingPostalCode', 'Shipping Zip/Postal Code'),
				],
				[c('BillingCountry', 'Billing Country'), c('ShippingCountry', 'Shipping Country')],
			]),
			sec('Description Information', 1, [[c('Description', 'Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const CONTACT_LAYOUT = {
		columns: 2,
		sections: [
			sec('Contact Information', 2, [
				[cRO('OwnerId', 'Contact Owner'), c('Phone', 'Business Phone')],
				[c('Salutation'), c('HomePhone', 'Home Phone')],
				[c('FirstName', 'First Name'), c('MobilePhone', 'Mobile Phone')],
				[cReq('LastName', 'Last Name'), c('OtherPhone', 'Other Phone')],
				[c('AccountId', 'Account Name'), c('Fax')],
				[c('Title'), c('Email')],
				[c('Department'), c('Birthdate')],
				[c('ReportsToId', 'Reports To'), c('LeadSource', 'Lead Source')],
			]),
			sec('Address Information', 1, [
				[c('MailingStreet', 'Mailing Street')],
				[c('MailingCity', 'Mailing City')],
				[c('MailingState', 'Mailing State/Province')],
				[c('MailingPostalCode', 'Mailing Zip/Postal Code')],
				[c('MailingCountry', 'Mailing Country')],
			]),
			sec('Description Information', 1, [[c('Description', 'Contact Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const OPPORTUNITY_LAYOUT = {
		columns: 2,
		sections: [
			sec('Opportunity Information', 2, [
				[cRO('OwnerId', 'Opportunity Owner'), c('Amount')],
				[c('IsPrivate', 'Private'), c('Probability', 'Probability (%)')],
				[cReq('Name', 'Opportunity Name'), cRO('ExpectedRevenue', 'Expected Revenue')],
				[c('AccountId', 'Account Name'), cReq('CloseDate', 'Close Date')],
				[c('Type', 'Opportunity Type'), c('NextStep', 'Next Step')],
				[c('LeadSource', 'Lead Source'), cReq('StageName', 'Stage')],
				[
					cRO('ForecastCategoryName', 'Forecast Category'),
					cRO('ForecastCategory', 'Forecast Category Picklist'),
				],
			]),
			sec('Additional Information', 2, [
				[cRO('IsClosed', 'Closed'), cRO('IsWon', 'Won')],
				[cRO('FiscalQuarter', 'Fiscal Quarter'), cRO('FiscalYear', 'Fiscal Year')],
				[cRO('HasOpportunityLineItem', 'Has Line Item'), null].filter(Boolean),
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const LEAD_LAYOUT = {
		columns: 2,
		sections: [
			sec('Lead Information', 2, [
				[cRO('OwnerId', 'Lead Owner'), c('Phone', 'Business Phone')],
				[c('Salutation'), c('MobilePhone', 'Mobile Phone')],
				[c('FirstName', 'First Name'), c('Fax')],
				[cReq('LastName', 'Last Name'), c('Email')],
				[cReq('Company', 'Company'), c('Website')],
				[c('Title'), cReq('Status', 'Lead Status')],
				[c('LeadSource', 'Lead Source'), c('Rating')],
				[c('Industry'), c('AnnualRevenue', 'Annual Revenue')],
				[c('NumberOfEmployees', 'No. of Employees'), c('DoNotCall', 'Do Not Call')],
			]),
			sec('Address Information', 1, [
				[c('Street')],
				[c('City')],
				[c('State', 'State/Province')],
				[c('PostalCode', 'Zip/Postal Code')],
				[c('Country')],
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const CASE_LAYOUT = {
		columns: 2,
		sections: [
			sec('Case Information', 2, [
				[cRO('OwnerId', 'Case Owner'), cReq('Status', 'Status')],
				[cRO('CaseNumber', 'Case Number'), c('Priority')],
				[c('AccountId', 'Account Name'), c('Type', 'Case Type')],
				[c('ContactId', 'Contact Name'), c('Reason', 'Case Reason')],
				[c('Origin', 'Case Origin'), c('IsEscalated', 'Escalated')],
			]),
			sec('Description Information', 1, [[c('Subject')], [c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const TASK_LAYOUT = {
		columns: 2,
		sections: [
			sec('Task Information', 2, [
				[cRO('OwnerId', 'Assigned To'), cReq('Status')],
				[cReq('Subject'), c('ActivityDate', 'Due Date')],
				[c('WhoId', 'Name'), c('Priority')],
				[c('WhatId', 'Related To'), c('IsReminderSet', 'Reminder')],
				[c('CallType', 'Call Type'), null].filter(Boolean),
			]),
			sec('Description Information', 1, [[c('Description', 'Comments')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const EVENT_LAYOUT = {
		columns: 2,
		sections: [
			sec('Calendar Details', 2, [
				[cRO('OwnerId', 'Assigned To'), c('IsAllDayEvent', 'All-Day Event')],
				[cReq('Subject'), c('Location')],
				[cReq('StartDateTime', 'Start'), c('ShowAs', 'Show Time As')],
				[c('EndDateTime', 'End'), c('IsPrivate', 'Private')],
				[c('DurationInMinutes', 'Duration (min)'), null].filter(Boolean),
				[c('WhoId', 'Name'), c('WhatId', 'Related To')],
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const CAMPAIGN_LAYOUT = {
		columns: 2,
		sections: [
			sec('Campaign Information', 2, [
				[cRO('OwnerId', 'Campaign Owner'), c('IsActive', 'Active')],
				[cReq('Name', 'Campaign Name'), c('Type')],
				[c('Status'), c('StartDate', 'Start Date')],
				[c('EndDate', 'End Date'), c('ExpectedResponse', 'Expected Response (%)')],
				[c('NumberSent', 'Num Sent'), null].filter(Boolean),
			]),
			sec('Planned Performance', 2, [
				[c('BudgetedCost', 'Budgeted Cost'), c('ActualCost', 'Actual Cost')],
				[c('ExpectedRevenue', 'Expected Revenue'), null].filter(Boolean),
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const CAMPAIGN_MEMBER_LAYOUT = {
		columns: 2,
		sections: [
			sec('Member Information', 2, [
				[cReq('CampaignId', 'Campaign'), c('Status')],
				[c('LeadId', 'Lead'), cRO('HasResponded', 'Responded')],
				[c('ContactId', 'Contact'), cRO('FirstRespondedDate', 'First Responded Date')],
			]),
			SYSTEM_INFO_SECTION,
		],
	};

	const PRODUCT_LAYOUT = {
		columns: 2,
		sections: [
			sec('Product Information', 2, [
				[cReq('Name', 'Product Name'), c('IsActive', 'Active')],
				[c('ProductCode', 'Product Code'), c('Family', 'Product Family')],
				[c('QuantityUnitOfMeasure', 'Quantity Unit'), null].filter(Boolean),
			]),
			sec('Description Information', 1, [[c('Description', 'Product Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const PRICEBOOK_LAYOUT = {
		columns: 2,
		sections: [
			sec('Price Book Information', 2, [
				[cReq('Name', 'Price Book Name'), c('IsActive', 'Active')],
				[cRO('IsStandard', 'Standard Price Book'), c('IsArchived', 'Archived')],
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const PRICEBOOK_ENTRY_LAYOUT = {
		columns: 2,
		sections: [
			sec('Price Book Entry Information', 2, [
				[cReq('Pricebook2Id', 'Price Book'), c('IsActive', 'Active')],
				[cReq('Product2Id', 'Product'), c('UseStandardPrice', 'Use Standard Price')],
				[cReq('UnitPrice', 'List Price'), null].filter(Boolean),
			]),
			SYSTEM_INFO_SECTION,
		],
	};

	const OPP_LINE_ITEM_LAYOUT = {
		columns: 2,
		sections: [
			sec('Product Information', 2, [
				[cReq('OpportunityId', 'Opportunity'), cReq('Quantity')],
				[cReq('PricebookEntryId', 'Price Book Entry'), c('UnitPrice', 'Sales Price')],
				[cRO('Product2Id', 'Product'), cRO('TotalPrice', 'Total Price')],
				[c('Discount', 'Discount (%)'), c('ServiceDate', 'Date')],
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const CONTRACT_LAYOUT = {
		columns: 2,
		sections: [
			sec('Contract Information', 2, [
				[cRO('OwnerId', 'Contract Owner'), cReq('Status')],
				[cRO('ContractNumber', 'Contract Number'), c('StartDate', 'Contract Start Date')],
				[cReq('AccountId', 'Account Name'), c('ContractTerm', 'Contract Term (months)')],
				[cRO('EndDate', 'Contract End Date'), null].filter(Boolean),
			]),
			sec('Address Information', 1, [
				[c('BillingStreet', 'Billing Street')],
				[c('BillingCity', 'Billing City')],
				[c('BillingState', 'Billing State/Province')],
				[c('BillingPostalCode', 'Billing Zip/Postal Code')],
				[c('BillingCountry', 'Billing Country')],
			]),
			sec('Description Information', 1, [[c('Description')], [c('SpecialTerms', 'Special Terms')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const ORDER_LAYOUT = {
		columns: 2,
		sections: [
			sec('Order Information', 2, [
				[cRO('OwnerId', 'Order Owner'), cReq('Status')],
				[cRO('OrderNumber', 'Order Number'), c('Type', 'Order Type')],
				[cReq('AccountId', 'Account Name'), cReq('EffectiveDate', 'Order Start Date')],
				[c('ContractId', 'Contract'), c('EndDate', 'Order End Date')],
				[c('OpportunityId', 'Opportunity'), cRO('TotalAmount', 'Order Amount')],
				[c('Pricebook2Id', 'Price Book'), null].filter(Boolean),
			]),
			sec('Address Information', 2, [
				[c('BillingStreet', 'Billing Street'), c('ShippingStreet', 'Shipping Street')],
				[c('BillingCity', 'Billing City'), c('ShippingCity', 'Shipping City')],
				[c('BillingState', 'Billing State/Province'), c('ShippingState', 'Shipping State/Province')],
				[
					c('BillingPostalCode', 'Billing Zip/Postal Code'),
					c('ShippingPostalCode', 'Shipping Zip/Postal Code'),
				],
				[c('BillingCountry', 'Billing Country'), c('ShippingCountry', 'Shipping Country')],
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const ORDER_ITEM_LAYOUT = {
		columns: 2,
		sections: [
			sec('Order Product Information', 2, [
				[cReq('OrderId', 'Order'), cReq('Quantity')],
				[cReq('PricebookEntryId', 'Price Book Entry'), c('UnitPrice')],
				[cRO('Product2Id', 'Product'), cRO('TotalPrice', 'Total Price')],
				[c('ServiceDate', 'Date'), null].filter(Boolean),
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const QUOTE_LAYOUT = {
		columns: 2,
		sections: [
			sec('Quote Information', 2, [
				[cRO('OwnerId', 'Quote Owner'), c('Status')],
				[cReq('Name', 'Quote Name'), cRO('QuoteNumber', 'Quote Number')],
				[cReq('OpportunityId', 'Opportunity'), c('ExpirationDate', 'Expiration Date')],
				[c('AccountId', 'Account'), c('ContactId', 'Contact')],
				[c('Pricebook2Id', 'Price Book'), null].filter(Boolean),
			]),
			sec('Totals', 2, [
				[cRO('Subtotal'), c('Discount', 'Discount (%)')],
				[cRO('TotalPrice', 'Total Price'), c('Tax')],
				[c('ShippingHandling', 'Shipping & Handling'), cRO('GrandTotal', 'Grand Total')],
			]),
			sec('Address Information', 1, [
				[c('BillingStreet', 'Billing Street')],
				[c('BillingCity', 'Billing City')],
				[c('BillingState', 'Billing State/Province')],
				[c('BillingPostalCode', 'Billing Zip/Postal Code')],
				[c('BillingCountry', 'Billing Country')],
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const QUOTE_LINE_ITEM_LAYOUT = {
		columns: 2,
		sections: [
			sec('Quote Line Item Information', 2, [
				[cReq('QuoteId', 'Quote'), cReq('Quantity')],
				[cReq('PricebookEntryId', 'Price Book Entry'), c('UnitPrice', 'Sales Price')],
				[cRO('Product2Id', 'Product'), cRO('TotalPrice', 'Total Price')],
				[c('Discount', 'Discount (%)'), c('ServiceDate', 'Date')],
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const ASSET_LAYOUT = {
		columns: 2,
		sections: [
			sec('Asset Information', 2, [
				[cReq('Name', 'Asset Name'), c('Status')],
				[c('AccountId', 'Account'), c('SerialNumber', 'Serial Number')],
				[c('ContactId', 'Contact'), c('Quantity')],
				[c('Product2Id', 'Product'), c('Price')],
				[c('PurchaseDate', 'Purchase Date'), c('InstallDate', 'Install Date')],
				[c('UsageEndDate', 'Usage End Date'), null].filter(Boolean),
			]),
			sec('Description Information', 1, [[c('Description')]]),
			SYSTEM_INFO_SECTION,
		],
	};

	const USER_LAYOUT = {
		columns: 2,
		sections: [
			sec('General Information', 2, [
				[cRO('Username'), cRO('Alias')],
				[cRO('FirstName', 'First Name'), cRO('Email')],
				[cRO('LastName', 'Last Name'), cRO('Title')],
				[cRO('Department'), cRO('Phone')],
				[cRO('IsActive', 'Active'), cRO('UserType', 'User Type')],
				[cRO('ManagerId', 'Manager'), null].filter(Boolean),
			]),
			sec('Locale Settings', 2, [
				[cRO('TimeZoneSidKey', 'Time Zone'), cRO('LocaleSidKey', 'Locale')],
				[cRO('LanguageLocaleKey', 'Language'), cRO('EmailEncodingKey', 'Email Encoding')],
			]),
		],
	};

	[
		ACCOUNT_DESCRIBE,
		CONTACT_DESCRIBE,
		OPPORTUNITY_DESCRIBE,
		LEAD_DESCRIBE,
		CASE_DESCRIBE,
		TASK_DESCRIBE,
		EVENT_DESCRIBE,
		CAMPAIGN_DESCRIBE,
		CAMPAIGN_MEMBER_DESCRIBE,
		PRODUCT_DESCRIBE,
		PRICEBOOK_DESCRIBE,
		PRICEBOOK_ENTRY_DESCRIBE,
		OPP_LINE_ITEM_DESCRIBE,
		CONTRACT_DESCRIBE,
		ORDER_DESCRIBE,
		ORDER_ITEM_DESCRIBE,
		QUOTE_DESCRIBE,
		QUOTE_LINE_ITEM_DESCRIBE,
		ASSET_DESCRIBE,
		USER_DESCRIBE,
	].forEach((describe) => {
		describe.deletable = describe.updateable !== false;
	});

	window.OrgLoomMock = Object.freeze({
		demoOrgId: '00DDEMO00000000AAA',
		demoUserId: '005DEMO00000000AAA',
		instanceUrl: 'https://demo.orgloom.local',

		objects: [
			{ name: 'Account', label: 'Account', keyPrefix: '001', custom: false, queryable: true },
			{ name: 'Contact', label: 'Contact', keyPrefix: '003', custom: false, queryable: true },
			{ name: 'Opportunity', label: 'Opportunity', keyPrefix: '006', custom: false, queryable: true },
			{ name: 'Lead', label: 'Lead', keyPrefix: '00Q', custom: false, queryable: true },
			{ name: 'Case', label: 'Case', keyPrefix: '500', custom: false, queryable: true },
			{ name: 'Task', label: 'Task', keyPrefix: '00T', custom: false, queryable: true },
			{ name: 'Event', label: 'Event', keyPrefix: '00U', custom: false, queryable: true },
			{ name: 'Campaign', label: 'Campaign', keyPrefix: '701', custom: false, queryable: true },
			{ name: 'CampaignMember', label: 'Campaign Member', keyPrefix: '00v', custom: false, queryable: true },
			{ name: 'Product2', label: 'Product', keyPrefix: '01t', custom: false, queryable: true },
			{ name: 'Pricebook2', label: 'Price Book', keyPrefix: '01s', custom: false, queryable: true },
			{ name: 'PricebookEntry', label: 'Price Book Entry', keyPrefix: '01u', custom: false, queryable: true },
			{
				name: 'OpportunityLineItem',
				label: 'Opportunity Product',
				keyPrefix: '00k',
				custom: false,
				queryable: true,
			},
			{ name: 'Contract', label: 'Contract', keyPrefix: '800', custom: false, queryable: true },
			{ name: 'Order', label: 'Order', keyPrefix: '801', custom: false, queryable: true },
			{ name: 'OrderItem', label: 'Order Product', keyPrefix: '802', custom: false, queryable: true },
			{ name: 'Quote', label: 'Quote', keyPrefix: '0Q0', custom: false, queryable: true },
			{ name: 'QuoteLineItem', label: 'Quote Line Item', keyPrefix: '0QL', custom: false, queryable: true },
			{ name: 'Asset', label: 'Asset', keyPrefix: '02i', custom: false, queryable: true },
			{ name: 'User', label: 'User', keyPrefix: '005', custom: false, queryable: true },
		],
		describes: {
			Account: ACCOUNT_DESCRIBE,
			Contact: CONTACT_DESCRIBE,
			Opportunity: OPPORTUNITY_DESCRIBE,
			Lead: LEAD_DESCRIBE,
			Case: CASE_DESCRIBE,
			Task: TASK_DESCRIBE,
			Event: EVENT_DESCRIBE,
			Campaign: CAMPAIGN_DESCRIBE,
			CampaignMember: CAMPAIGN_MEMBER_DESCRIBE,
			Product2: PRODUCT_DESCRIBE,
			Pricebook2: PRICEBOOK_DESCRIBE,
			PricebookEntry: PRICEBOOK_ENTRY_DESCRIBE,
			OpportunityLineItem: OPP_LINE_ITEM_DESCRIBE,
			Contract: CONTRACT_DESCRIBE,
			Order: ORDER_DESCRIBE,
			OrderItem: ORDER_ITEM_DESCRIBE,
			Quote: QUOTE_DESCRIBE,
			QuoteLineItem: QUOTE_LINE_ITEM_DESCRIBE,
			Asset: ASSET_DESCRIBE,
			User: USER_DESCRIBE,
		},
		layouts: {
			Account: ACCOUNT_LAYOUT,
			Contact: CONTACT_LAYOUT,
			Opportunity: OPPORTUNITY_LAYOUT,
			Lead: LEAD_LAYOUT,
			Case: CASE_LAYOUT,
			Task: TASK_LAYOUT,
			Event: EVENT_LAYOUT,
			Campaign: CAMPAIGN_LAYOUT,
			CampaignMember: CAMPAIGN_MEMBER_LAYOUT,
			Product2: PRODUCT_LAYOUT,
			Pricebook2: PRICEBOOK_LAYOUT,
			PricebookEntry: PRICEBOOK_ENTRY_LAYOUT,
			OpportunityLineItem: OPP_LINE_ITEM_LAYOUT,
			Contract: CONTRACT_LAYOUT,
			Order: ORDER_LAYOUT,
			OrderItem: ORDER_ITEM_LAYOUT,
			Quote: QUOTE_LAYOUT,
			QuoteLineItem: QUOTE_LINE_ITEM_LAYOUT,
			Asset: ASSET_LAYOUT,
			User: USER_LAYOUT,
		},
		records: {
			Account: ACCOUNTS,
			Contact: CONTACTS,
			Opportunity: OPPORTUNITIES,
			Lead: LEADS,
			Case: CASES,
			Task: TASKS,
			Event: EVENTS,
			Campaign: CAMPAIGNS,
			CampaignMember: CAMPAIGN_MEMBERS,
			Product2: PRODUCTS,
			Pricebook2: PRICEBOOKS,
			PricebookEntry: PRICEBOOK_ENTRIES,
			OpportunityLineItem: OPP_LINE_ITEMS,
			Contract: CONTRACTS,
			Order: ORDERS,
			OrderItem: ORDER_ITEMS,
			Quote: QUOTES,
			QuoteLineItem: QUOTE_LINE_ITEMS,
			Asset: ASSETS,
			User: USERS,
		},
	});
})();
