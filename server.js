/**
 * 김프방 자동화 시스템 - Node.js 서버
 * 텔레그램 봇과 구글 시트 연동
 */

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 환경변수
const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const UPBIT_ACCESS_KEY = process.env.UPBIT_ACCESS_KEY || '';
const UPBIT_SECRET_KEY = process.env.UPBIT_SECRET_KEY || '';
const COINONE_ACCESS_TOKEN = process.env.COINONE_ACCESS_TOKEN || '';
const COINONE_SECRET_KEY = process.env.COINONE_SECRET_KEY || '';

// 구글 시트 API 설정
let sheets;
let auth;

// 모니터링 설정
let depositMonitoringActive = false;
let lastCheckedDepositId = null;
let monitoringChatId = null;

async function initializeGoogleSheets() {
  try {
    const credentials = JSON.parse(GOOGLE_CREDENTIALS);
    auth = new GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    
    sheets = google.sheets({ version: 'v4', auth });
    console.log('구글 시트 API 초기화 완료');
  } catch (error) {
    console.error('구글 시트 API 초기화 오류:', error);
  }
}

// 텔레그램 메시지 전송
async function sendTelegramMessage(chatId, text) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };
    
    await axios.post(url, payload);
    console.log('텔레그램 메시지 전송 완료');
  } catch (error) {
    console.error('텔레그램 메시지 전송 오류:', error);
  }
}

// 계좌정보 조회
async function getAccountInfo(accountCode) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '당일작업!W:Z'
    });

    const data = response.data.values;
    if (!data || data.length === 0) {
      console.log('계좌정보 데이터가 없습니다.');
      return null;
    }

    console.log(`계좌코드 검색 중: ${accountCode}`);
    console.log(`계좌정보 데이터 행 수: ${data.length}`);

    for (let i = 0; i < data.length; i++) {
      if (data[i] && data[i][3] === accountCode) { // Z열 (계좌코드)
        console.log(`계좌정보 찾음: ${JSON.stringify(data[i])}`);
        return {
          name: data[i][0], // W열 (이름)
          platform: data[i][1], // X열 (플랫폼)
          bankInfo: data[i][2] // Y열 (계좌정보)
        };
      }
    }
    console.log(`계좌코드 ${accountCode}를 찾을 수 없습니다.`);
    return null;
  } catch (error) {
    console.error('계좌정보 조회 오류:', error);
    return null;
  }
}

// 발급코드 생성
function generateIssueCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// 외화 종류 정규화
function normalizeCurrency(currency) {
  const currencyMap = {
    '홍달': 'HKD',
    '미달': 'USD',
    '홍콩달러': 'HKD',
    '미국달러': 'USD'
  };
  return currencyMap[currency] || currency.toUpperCase();
}

// 대기상태 생성
async function createWaitingStatus(accountCode, amount, foreignAmount, currencyType) {
  try {
    // 계좌정보 조회
    const accountData = await getAccountInfo(accountCode);
    if (!accountData) {
      return '등록을 실패하였습니다. (계좌코드 오류)';
    }
    
    // 발급코드 생성
    const issueCode = generateIssueCode();
    
    // 외화 종류 정규화
    const normalizedCurrency = normalizeCurrency(currencyType);
    
    // 당일작업시트지에 데이터 입력
    const today = new Date().toLocaleDateString('ko-KR');
    const rowData = [
      today, // 입금날짜
      accountData.name, // 이름
      accountData.platform, // 플랫폼
      accountData.bankInfo, // 계좌정보
      '', // 입금
      amount, // 출금
      '', // 수익
      '', // 수익입금
      '', // 정산
      '', // 외화입금날짜
      foreignAmount, // 외화
      '', // 외화입금
      '', // 외화출금
      normalizedCurrency, // 종류
      '', // 진행여부
      '', // 바낸달러
      '', // 최종달러
      issueCode, // 발급코드
      '', // 달러가격
      accountCode // 계좌코드
    ];

    console.log('시트에 저장할 데이터:', rowData);

    const appendResult = await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '당일작업!A:T',
      valueInputOption: 'RAW',
      resource: { values: [rowData] }
    });

    console.log('데이터 저장 완료:', appendResult.data);

    return `정상등록 되었습니다.\n발급코드 : ${issueCode}`;
    
  } catch (error) {
    console.error('대기상태 생성 오류:', error);
    return '등록을 실패하였습니다. (형식오류)';
  }
}

// 상태 변경 처리
async function processStatusChange(issueCode, command, value) {
  try {
    // 당일작업시트지에서 해당 발급코드 찾기
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '당일작업!A:T'
    });
    
    const data = response.data.values;
    let targetRow = -1;
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][17] === issueCode) { // R열 (발급코드)
        targetRow = i + 1;
        break;
      }
    }
    
    if (targetRow === -1) {
      return '해당 코드를 찾을 수 없습니다.';
    }
    
    switch (command) {
      case '외화입금':
        return await processForeignDeposit(issueCode, value, targetRow);
      case '진행':
        return await processProgress(issueCode, targetRow);
      case '바낸달러':
        return await processRemainingDollar(issueCode, value, targetRow);
      case '입금':
        return await processDeposit(issueCode, value, targetRow);
      case '정산':
        return await processSettlement(issueCode, value, targetRow);
      case '정산완료':
        return await processSettlementComplete(issueCode, targetRow);
      default:
        return '알 수 없는 명령어입니다.';
    }
  } catch (error) {
    console.error('상태 변경 처리 오류:', error);
    return '명령어 처리 중 오류가 발생했습니다.';
  }
}

// 외화입금 처리
async function processForeignDeposit(issueCode, amount, row) {
  try {
    const today = new Date();
    
    // 외화입금날짜 설정
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!J${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[today]] }
    });
    
    // 외화입금 설정
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!L${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[amount]] }
    });
    
    // 외화출금 계산 (HKD:-15, USD:-2)
    const currencyType = await getCellValue('당일작업!N' + row);
    const foreignWithdrawal = currencyType === 'HKD' ? 
      parseInt(amount) - 15 : parseInt(amount) - 2;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!M${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[foreignWithdrawal]] }
    });
    
    return `코드 : ${issueCode} 금액 : ${foreignWithdrawal} 거래소입금요망!`;
    
  } catch (error) {
    console.error('외화입금 처리 오류:', error);
    return '외화입금 처리 중 오류가 발생했습니다.';
  }
}

// 진행 처리
async function processProgress(issueCode, row) {
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!O${row}`,
      valueInputOption: 'RAW',
      resource: { values: [['진행']] }
    });
    
    const foreignWithdrawal = await getCellValue('당일작업!M' + row);
    return `코드 : ${issueCode} 금액 : ${foreignWithdrawal} 작업중!`;
    
  } catch (error) {
    console.error('진행 처리 오류:', error);
    return '진행 처리 중 오류가 발생했습니다.';
  }
}

// 바낸달러 처리
async function processRemainingDollar(issueCode, amount, row) {
  try {
    // 바낸달러 설정
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!P${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[amount]] }
    });
    
    // 최종달러 = 바낸달러 - 1
    const finalDollar = parseInt(amount) - 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!Q${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[finalDollar]] }
    });
    
    // 달러가격 업데이트
    await updateDollarPrice(row);
    
    const bankInfo = await getCellValue('당일작업!D' + row);
    const name = await getCellValue('당일작업!B' + row);
    const withdrawal = await getCellValue('당일작업!F' + row);
    const dollarPrice = await getCellValue('당일작업!S' + row);
    
    return `코드 : ${issueCode} , 달러 ${finalDollar} 가격 : ${dollarPrice}\n${bankInfo} ${name} ${formatNumber(withdrawal)}원 입금요망`;
    
  } catch (error) {
    console.error('바낸달러 처리 오류:', error);
    return '바낸달러 처리 중 오류가 발생했습니다.';
  }
}

// 입금 처리
async function processDeposit(issueCode, amount, row) {
  try {
    // 입금 설정
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!E${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[amount]] }
    });
    
    // 수익 계산
    const finalDollar = await getCellValue('당일작업!Q' + row);
    const dollarPrice = await getCellValue('당일작업!S' + row);
    const withdrawal = await getCellValue('당일작업!F' + row);
    
    const profit = Math.floor((finalDollar * dollarPrice - withdrawal) / 2);
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!G${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[profit]] }
    });
    
    const name = await getCellValue('당일작업!B' + row);
    return `코드 : ${issueCode} ${name} ${formatNumber(profit)}원 입금요망`;
    
  } catch (error) {
    console.error('입금 처리 오류:', error);
    return '입금 처리 중 오류가 발생했습니다.';
  }
}

// 정산 처리
async function processSettlement(issueCode, amount, row) {
  try {
    // 수익입금 설정
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!H${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[amount]] }
    });
    
    // 정산완료 설정
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!I${row}`,
      valueInputOption: 'RAW',
      resource: { values: [['정산완료']] }
    });
    
    const name = await getCellValue('당일작업!B' + row);
    return `코드:${issueCode} ${name} ${formatNumber(amount)}원 정산완료`;
    
  } catch (error) {
    console.error('정산 처리 오류:', error);
    return '정산 처리 중 오류가 발생했습니다.';
  }
}

// 정산완료 처리
async function processSettlementComplete(issueCode, row) {
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일작업!I${row}`,
      valueInputOption: 'RAW',
      resource: { values: [['정산완료']] }
    });
    
    const name = await getCellValue('당일작업!B' + row);
    return `코드:${issueCode} ${name} 정산완료`;
    
  } catch (error) {
    console.error('정산완료 처리 오류:', error);
    return '정산완료 처리 중 오류가 발생했습니다.';
  }
}

// 달러가격 업데이트
async function updateDollarPrice(row) {
  try {
    // 출금내역시트에서 당일달러 가격 가져오기
    const today = new Date();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '출금내역시트!A:P'
    });
    
    const data = response.data.values;
    let todayDollarPrice = null;
    
    for (let i = 1; i < data.length; i++) {
      const rowDate = new Date(data[i][0]);
      if (isSameDay(today, rowDate)) {
        todayDollarPrice = data[i][15]; // P열 당일달러
        break;
      }
    }
    
    if (todayDollarPrice) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `당일작업!S${row}`,
        valueInputOption: 'RAW',
        resource: { values: [[todayDollarPrice]] }
      });
    }
  } catch (error) {
    console.error('달러가격 업데이트 오류:', error);
  }
}

// 셀 값 가져오기
async function getCellValue(range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: range
    });
    return response.data.values ? response.data.values[0][0] : '';
  } catch (error) {
    console.error('셀 값 가져오기 오류:', error);
    return '';
  }
}

// 유틸리티 함수들
function formatNumber(num) {
  if (!num) return '0';
  return parseInt(num).toLocaleString();
}

function isSameDay(date1, date2) {
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth() === date2.getMonth() &&
         date1.getDate() === date2.getDate();
}

// 텔레그램 웹훅 처리
app.post('/webhook', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || !message.text) {
      return res.status(200).send('OK');
    }
    
    const chatId = message.chat.id;
    const text = message.text.trim();
    const userId = message.from.id;
    const userName = message.from.first_name || 'Unknown';
    
    console.log(`메시지 수신: ${text} (${userName})`);

    // 명령어 처리
    const response = await processTelegramCommand(text, chatId, userId, userName);

    // 텔레그램 봇으로 응답 전송
    await sendTelegramMessage(chatId, response);
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('웹훅 처리 오류:', error);
    res.status(500).send('Error');
  }
});

// 텔레그램 명령어 처리
async function processTelegramCommand(text, chatId, userId, userName) {
  const parts = text.split(' ');
  const command = parts[0].toLowerCase();
  
  try {
    // 1. 대기상태 생성 (계좌코드 + 금액 + 외화 + 종류)
    if (parts.length === 4 && !isNaN(parts[1]) && !isNaN(parts[2])) {
      return await createWaitingStatus(parts[0], parts[1], parts[2], parts[3]);
    }
    
    // 2. 상태별 명령어 처리
    switch (command) {
      case '대기목록':
        return await getWaitingList();
      case '진행대기목록':
        return await getProgressWaitingList();
      case '진행중':
        return await getProgressList();
      case '정산대기':
        return await getSettlementWaitingList();
      case '정산중':
        return await getSettlementList();
      case '정산완료':
        return await getSettlementCompleteList();
      case '마무리':
        return await getCompleteList();
      case '리빌드':
        return await executeRebuild();
      case '업비트업데이트':
      case '업비트':
        const upbitResult = await updateUpbitData();
        return upbitResult.message;
      case '코인원업데이트':
      case '코인원':
        const coinoneResult = await updateCoinoneData();
        return coinoneResult.message;
      case '전체업데이트':
      case '출금내역업데이트':
        const upbitRes = await updateUpbitData();
        const coinoneRes = await updateCoinoneData();
        return `${upbitRes.message}\n${coinoneRes.message}`;
      case '입금체크':
      case '입금모니터링':
      case '모니터링시작':
        return await startDepositMonitoring(chatId);
      case '모니터링중지':
      case '입금체크중지':
        return stopDepositMonitoring();
      case '대기':
      case '진행대기':
      case '진행중':
      case '정산대기':
      case '정산중':
      case '정산완료':
      case '마무리':
        return await getStatusList(command);
    }
    
    // 3. 코드별 조회
    if (command.startsWith('코드')) {
      const code = command.replace('코드', '');
      return await getCodeInfo(code);
    }
    
    // 4. 이름별 조회
    if (isValidName(command)) {
      return await getUserStatus(command);
    }
    
    // 5. 상태 변경 명령어
    if (parts.length >= 2) {
      return await processStatusChange(parts[0], parts[1], parts[2]);
    }
    
    return '알 수 없는 명령어입니다.';
    
  } catch (error) {
    console.error('명령어 처리 오류:', error);
    return '명령어 처리 중 오류가 발생했습니다.';
  }
}

// 상태별 목록 조회 함수들
async function getWaitingList() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '당일작업!A:T'
    });

    const data = response.data.values;
    if (!data || data.length <= 1) {
      return '대기 중인 작업이 없습니다.';
    }

    const waitingItems = [];

    // 헤더 제외하고 데이터 조회 (i=1부터 시작)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // 대기 상태 조건: 외화입금날짜(J열=9), 외화입금(L열=11), 진행여부(O열=14)가 모두 비어있음
      const isWaiting = !row[9] && !row[11] && !row[14];

      if (isWaiting) {
        const date = row[0] || ''; // A열: 입금날짜
        const issueCode = row[17] || ''; // R열: 발급코드
        const withdrawal = row[5] || '0'; // F열: 출금
        const foreignAmount = row[10] || '0'; // K열: 외화
        const currency = row[13] || ''; // N열: 종류

        waitingItems.push(
          `${date}, 코드:${issueCode}, ${formatNumber(withdrawal)}원, ${foreignAmount}${currency}, 해외계좌입금전`
        );
      }
    }

    if (waitingItems.length === 0) {
      return '대기 중인 작업이 없습니다.';
    }

    return `📋 대기 목록\n\n` + waitingItems.join('\n');

  } catch (error) {
    console.error('대기 목록 조회 오류:', error);
    return '대기 목록 조회 중 오류가 발생했습니다.';
  }
}

async function getProgressWaitingList() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '당일작업!A:T'
    });

    const data = response.data.values;
    if (!data || data.length <= 1) {
      return '진행대기 중인 작업이 없습니다.';
    }

    const items = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // 진행대기 상태: 외화입금(L열=11)이 있고, 진행여부(O열=14)가 비어있음
      const isProgressWaiting = row[11] && !row[14];

      if (isProgressWaiting) {
        const date = row[0] || '';
        const issueCode = row[17] || '';
        const withdrawal = row[5] || '0';
        const foreignAmount = row[10] || '0';
        const currency = row[13] || '';

        items.push(
          `${date}, 코드:${issueCode}, ${formatNumber(withdrawal)}원, ${foreignAmount}${currency}, 거래소입금전`
        );
      }
    }

    if (items.length === 0) {
      return '진행대기 중인 작업이 없습니다.';
    }

    return `📋 진행대기 목록\n\n` + items.join('\n');

  } catch (error) {
    console.error('진행대기 목록 조회 오류:', error);
    return '진행대기 목록 조회 중 오류가 발생했습니다.';
  }
}

async function getProgressList() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '당일작업!A:T'
    });

    const data = response.data.values;
    if (!data || data.length <= 1) {
      return '진행 중인 작업이 없습니다.';
    }

    const items = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // 진행중 상태: 진행여부(O열=14)가 "진행"이고, 최종달러(Q열=16)가 비어있음
      const isProgress = row[14] === '진행' && !row[16];

      if (isProgress) {
        const date = row[0] || '';
        const issueCode = row[17] || '';
        const withdrawal = row[5] || '0';
        const foreignAmount = row[10] || '0';
        const currency = row[13] || '';

        items.push(
          `${date}, 코드:${issueCode}, ${formatNumber(withdrawal)}원, ${foreignAmount}${currency}, 작업중`
        );
      }
    }

    if (items.length === 0) {
      return '진행 중인 작업이 없습니다.';
    }

    return `📋 진행 중 목록\n\n` + items.join('\n');

  } catch (error) {
    console.error('진행중 목록 조회 오류:', error);
    return '진행중 목록 조회 중 오류가 발생했습니다.';
  }
}

async function getSettlementWaitingList() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '당일작업!A:T'
    });

    const data = response.data.values;
    if (!data || data.length <= 1) {
      return '정산대기 중인 작업이 없습니다.';
    }

    const items = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // 정산대기 상태: 최종달러(Q열=16)가 있고, 입금(E열=4)이 비어있음
      const isSettlementWaiting = row[16] && !row[4];

      if (isSettlementWaiting) {
        const date = row[0] || '';
        const issueCode = row[17] || '';
        const withdrawal = row[5] || '0';
        const finalDollar = row[16] || '0';
        const dollarPrice = row[18] || '0';

        items.push(
          `${date}, 코드:${issueCode}, ${formatNumber(withdrawal)}원, 최종달러:${finalDollar}, 달러가격:${dollarPrice}`
        );
      }
    }

    if (items.length === 0) {
      return '정산대기 중인 작업이 없습니다.';
    }

    return `📋 정산대기 목록\n\n` + items.join('\n');

  } catch (error) {
    console.error('정산대기 목록 조회 오류:', error);
    return '정산대기 목록 조회 중 오류가 발생했습니다.';
  }
}

async function getSettlementList() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '당일작업!A:T'
    });

    const data = response.data.values;
    if (!data || data.length <= 1) {
      return '정산 중인 작업이 없습니다.';
    }

    const items = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // 정산중 상태: 수익(G열=6)이 있고, 정산(I열=8)이 비어있음
      const isSettlement = row[6] && !row[8];

      if (isSettlement) {
        const date = row[0] || '';
        const issueCode = row[17] || '';
        const deposit = row[4] || '0';
        const profit = row[6] || '0';

        items.push(
          `${date}, 코드:${issueCode}, ${formatNumber(deposit)}원, 수익:${formatNumber(profit)}원`
        );
      }
    }

    if (items.length === 0) {
      return '정산 중인 작업이 없습니다.';
    }

    return `📋 정산 중 목록\n\n` + items.join('\n');

  } catch (error) {
    console.error('정산중 목록 조회 오류:', error);
    return '정산중 목록 조회 중 오류가 발생했습니다.';
  }
}

async function getSettlementCompleteList() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '당일작업!A:T'
    });

    const data = response.data.values;
    if (!data || data.length <= 1) {
      return '정산완료된 작업이 없습니다.';
    }

    const items = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // 정산완료 상태: 정산(I열=8)이 "정산완료"
      const isComplete = row[8] === '정산완료';

      if (isComplete) {
        const date = row[0] || '';
        const issueCode = row[17] || '';
        const deposit = row[4] || '0';
        const profit = row[6] || '0';

        items.push(
          `${date}, 코드:${issueCode}, ${formatNumber(deposit)}원, 수익:${formatNumber(profit)}원`
        );
      }
    }

    if (items.length === 0) {
      return '정산완료된 작업이 없습니다.';
    }

    return `📋 정산완료 목록\n\n` + items.join('\n');

  } catch (error) {
    console.error('정산완료 목록 조회 오류:', error);
    return '정산완료 목록 조회 중 오류가 발생했습니다.';
  }
}

async function getCompleteList() {
  return '마무리 목록 조회 기능을 구현 중입니다.';
}

async function executeRebuild() {
  return '리빌드 기능을 구현 중입니다.';
}

async function getStatusList(status) {
  return `${status} 상태 목록 조회 기능을 구현 중입니다.`;
}

async function getCodeInfo(code) {
  return `코드 ${code} 정보 조회 기능을 구현 중입니다.`;
}

async function getUserStatus(name) {
  return `${name} 사용자 상태 조회 기능을 구현 중입니다.`;
}

function isValidName(name) {
  const validNames = ['김도윤', '이철수', '정수진', '곽성민', '강경아'];
  return validNames.includes(name);
}

// ============================================
// 업비트 API 연동
// ============================================

// 업비트 JWT 토큰 생성
function generateUpbitToken(queryParams = null) {
  const payload = {
    access_key: UPBIT_ACCESS_KEY,
    nonce: uuidv4(),
  };

  if (queryParams) {
    const query = new URLSearchParams(queryParams).toString();
    const hash = crypto.createHash('sha512');
    const queryHash = hash.update(query, 'utf-8').digest('hex');
    payload.query_hash = queryHash;
    payload.query_hash_alg = 'SHA512';
  }

  return jwt.sign(payload, UPBIT_SECRET_KEY);
}

// 업비트 입금 내역 조회
async function getUpbitDeposits(currency = 'USDT', state = 'ACCEPTED', limit = 100) {
  try {
    const params = { currency, state, limit };
    const token = generateUpbitToken(params);

    const response = await axios.get('https://api.upbit.com/v1/deposits', {
      params,
      headers: { Authorization: `Bearer ${token}` }
    });

    return response.data;
  } catch (error) {
    console.error('업비트 입금 내역 조회 오류:', error.response?.data || error.message);
    return [];
  }
}

// 업비트 출금 내역 조회
async function getUpbitWithdrawals(currency = 'KRW', state = 'DONE', limit = 100) {
  try {
    const params = { currency, state, limit };
    const token = generateUpbitToken(params);

    const response = await axios.get('https://api.upbit.com/v1/withdraws', {
      params,
      headers: { Authorization: `Bearer ${token}` }
    });

    return response.data;
  } catch (error) {
    console.error('업비트 출금 내역 조회 오류:', error.response?.data || error.message);
    return [];
  }
}

// 업비트 주문 내역 조회 (판매 내역)
async function getUpbitOrders(market = 'KRW-USDT', state = 'done', limit = 100) {
  try {
    const params = { market, state, limit };
    const token = generateUpbitToken(params);

    const response = await axios.get('https://api.upbit.com/v1/orders', {
      params,
      headers: { Authorization: `Bearer ${token}` }
    });

    return response.data;
  } catch (error) {
    console.error('업비트 주문 내역 조회 오류:', error.response?.data || error.message);
    return [];
  }
}

// ============================================
// 코인원 API 연동
// ============================================

// 코인원 API 서명 생성
function generateCoinoneSignature(payload) {
  const encoded_payload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto
    .createHmac('sha512', COINONE_SECRET_KEY.toUpperCase())
    .update(encoded_payload)
    .digest('hex');

  return { encoded_payload, signature };
}

// 코인원 입출금 내역 조회
async function getCoinoneTransactions(currency = 'usdt') {
  try {
    const payload = {
      access_token: COINONE_ACCESS_TOKEN,
      currency: currency.toLowerCase(),
      nonce: Date.now()
    };

    const { encoded_payload, signature } = generateCoinoneSignature(payload);

    const response = await axios.post('https://api.coinone.co.kr/v2/transaction/coin/', payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-COINONE-PAYLOAD': encoded_payload,
        'X-COINONE-SIGNATURE': signature
      }
    });

    return response.data;
  } catch (error) {
    console.error('코인원 입출금 내역 조회 오류:', error.response?.data || error.message);
    return { result: 'error', transactions: [] };
  }
}

// 코인원 원화 입출금 내역 조회
async function getCoinoneKRWTransactions() {
  try {
    const payload = {
      access_token: COINONE_ACCESS_TOKEN,
      nonce: Date.now()
    };

    const { encoded_payload, signature } = generateCoinoneSignature(payload);

    const response = await axios.post('https://api.coinone.co.kr/v2/transaction/krw/', payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-COINONE-PAYLOAD': encoded_payload,
        'X-COINONE-SIGNATURE': signature
      }
    });

    return response.data;
  } catch (error) {
    console.error('코인원 원화 입출금 내역 조회 오류:', error.response?.data || error.message);
    return { result: 'error', transactions: [] };
  }
}

// ============================================
// 출금내역 시트 데이터 처리
// ============================================

// 업비트 데이터 수집 및 구글 시트 업데이트
async function updateUpbitData() {
  try {
    // USDT 입금 내역 조회
    const deposits = await getUpbitDeposits('USDT');

    // 주문 내역 조회 (판매)
    const orders = await getUpbitOrders('KRW-USDT', 'done');

    // KRW 출금 내역 조회
    const withdrawals = await getUpbitWithdrawals('KRW');

    // 날짜별로 데이터 그룹화
    const dailyData = {};

    // 입금 데이터 처리
    deposits.forEach(deposit => {
      const date = new Date(deposit.done_at).toLocaleDateString('ko-KR');
      if (!dailyData[date]) dailyData[date] = { deposits: 0, sales: 0, salesAmount: 0, withdrawals: 0 };
      dailyData[date].deposits += parseFloat(deposit.amount);
    });

    // 판매 데이터 처리 (완전히 체결된 주문만)
    orders.forEach(order => {
      if (order.side === 'ask' && parseFloat(order.executed_volume) === parseFloat(order.volume)) {
        const date = new Date(order.created_at).toLocaleDateString('ko-KR');
        if (!dailyData[date]) dailyData[date] = { deposits: 0, sales: 0, salesAmount: 0, withdrawals: 0 };
        dailyData[date].sales += parseFloat(order.executed_volume);
        dailyData[date].salesAmount += parseFloat(order.price) * parseFloat(order.executed_volume);
      }
    });

    // 출금 데이터 처리
    withdrawals.forEach(withdrawal => {
      const date = new Date(withdrawal.done_at).toLocaleDateString('ko-KR');
      if (!dailyData[date]) dailyData[date] = { deposits: 0, sales: 0, salesAmount: 0, withdrawals: 0 };
      dailyData[date].withdrawals += parseFloat(withdrawal.amount);
    });

    // 구글 시트에 업데이트
    for (const [date, data] of Object.entries(dailyData)) {
      const averageDollar = data.sales > 0 ? Math.round(data.salesAmount / data.sales) : 0;

      await updateWithdrawalSheet('upbit', date, {
        depositDate: date,
        depositDollar: Math.round(data.deposits),
        salesDollar: Math.round(data.sales),
        salesAmount: Math.round(data.salesAmount),
        withdrawalDate: date,
        withdrawalAmount: Math.round(data.withdrawals),
        averageDollar: averageDollar
      });
    }

    return { success: true, message: '업비트 데이터 업데이트 완료' };
  } catch (error) {
    console.error('업비트 데이터 업데이트 오류:', error);
    return { success: false, message: '업비트 데이터 업데이트 실패' };
  }
}

// 코인원 데이터 수집 및 구글 시트 업데이트
async function updateCoinoneData() {
  try {
    // USDT 입출금 내역 조회
    const usdtTransactions = await getCoinoneTransactions('usdt');

    // KRW 입출금 내역 조회
    const krwTransactions = await getCoinoneKRWTransactions();

    // 날짜별로 데이터 그룹화
    const dailyData = {};

    // USDT 거래 데이터 처리
    if (usdtTransactions.transactions) {
      usdtTransactions.transactions.forEach(tx => {
        const date = new Date(parseInt(tx.timestamp) * 1000).toLocaleDateString('ko-KR');
        if (!dailyData[date]) dailyData[date] = { deposits: 0, sales: 0, salesAmount: 0, withdrawals: 0 };

        if (tx.type === 'deposit') {
          dailyData[date].deposits += parseFloat(tx.amount);
        }
      });
    }

    // KRW 출금 데이터 처리
    if (krwTransactions.transactions) {
      krwTransactions.transactions.forEach(tx => {
        const date = new Date(parseInt(tx.timestamp) * 1000).toLocaleDateString('ko-KR');
        if (!dailyData[date]) dailyData[date] = { deposits: 0, sales: 0, salesAmount: 0, withdrawals: 0 };

        if (tx.type === 'withdrawal') {
          dailyData[date].withdrawals += parseFloat(tx.amount);
        }
      });
    }

    // 구글 시트에 업데이트
    for (const [date, data] of Object.entries(dailyData)) {
      const averageDollar = data.sales > 0 ? Math.round(data.salesAmount / data.sales) : 0;

      await updateWithdrawalSheet('coinone', date, {
        depositDate: date,
        depositDollar: Math.round(data.deposits),
        salesDollar: Math.round(data.sales),
        salesAmount: Math.round(data.salesAmount),
        withdrawalDate: date,
        withdrawalAmount: Math.round(data.withdrawals),
        averageDollar: averageDollar
      });
    }

    return { success: true, message: '코인원 데이터 업데이트 완료' };
  } catch (error) {
    console.error('코인원 데이터 업데이트 오류:', error);
    return { success: false, message: '코인원 데이터 업데이트 실패' };
  }
}

// 출금내역 시트 업데이트
async function updateWithdrawalSheet(exchange, date, data) {
  try {
    // 출금내역 시트 읽기
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '출금내역!A:P'
    });

    const sheetData = response.data.values || [];
    let rowIndex = -1;

    // 업비트: A~G 열, 코인원: I~O 열
    const colOffset = exchange === 'upbit' ? 0 : 8;

    // 해당 날짜 찾기
    for (let i = 1; i < sheetData.length; i++) {
      const cellDate = sheetData[i][colOffset];
      if (cellDate === date) {
        rowIndex = i + 1;
        break;
      }
    }

    // 새 행 추가 또는 기존 행 업데이트
    if (rowIndex === -1) {
      // 새 행 추가
      const newRow = exchange === 'upbit'
        ? [
            data.depositDate,
            data.depositDollar,
            data.salesDollar,
            data.salesAmount,
            data.withdrawalDate,
            data.withdrawalAmount,
            data.averageDollar
          ]
        : Array(8).fill('').concat([
            data.depositDate,
            data.depositDollar,
            data.salesDollar,
            data.salesAmount,
            data.withdrawalDate,
            data.withdrawalAmount,
            data.averageDollar
          ]);

      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: '출금내역!A:P',
        valueInputOption: 'RAW',
        resource: { values: [newRow] }
      });
    } else {
      // 기존 행 업데이트
      const startCol = exchange === 'upbit' ? 'A' : 'I';
      const endCol = exchange === 'upbit' ? 'G' : 'O';

      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `출금내역!${startCol}${rowIndex}:${endCol}${rowIndex}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[
            data.depositDate,
            data.depositDollar,
            data.salesDollar,
            data.salesAmount,
            data.withdrawalDate,
            data.withdrawalAmount,
            data.averageDollar
          ]]
        }
      });
    }

    // 당일달러 계산 및 업데이트 (P열)
    await updateDailyDollar(rowIndex === -1 ? sheetData.length + 1 : rowIndex);

    console.log(`${exchange} 데이터 업데이트 완료: ${date}`);
  } catch (error) {
    console.error('출금내역 시트 업데이트 오류:', error);
  }
}

// 당일달러 계산 (업비트 평균 + 코인원 평균 / 2)
async function updateDailyDollar(rowIndex) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `출금내역!G${rowIndex}:O${rowIndex}`
    });

    if (response.data.values && response.data.values.length > 0) {
      const row = response.data.values[0];
      const upbitAvg = parseFloat(row[0]) || 0; // G열
      const coinoneAvg = parseFloat(row[8]) || 0; // O열

      const dailyDollar = upbitAvg > 0 && coinoneAvg > 0
        ? Math.round((upbitAvg + coinoneAvg) / 2)
        : upbitAvg > 0 ? upbitAvg : coinoneAvg;

      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `출금내역!P${rowIndex}`,
        valueInputOption: 'RAW',
        resource: { values: [[dailyDollar]] }
      });
    }
  } catch (error) {
    console.error('당일달러 계산 오류:', error);
  }
}

// ============================================
// USDT 입금 실시간 모니터링
// ============================================

// 업비트 USDT 입금 체크
async function checkUpbitDeposits() {
  try {
    const deposits = await getUpbitDeposits('USDT', 'ACCEPTED', 10);

    if (!deposits || deposits.length === 0) {
      return null;
    }

    // 가장 최근 입금 확인
    const latestDeposit = deposits[0];

    // 새로운 입금인지 체크
    if (lastCheckedDepositId === null) {
      lastCheckedDepositId = latestDeposit.uuid;
      return null;
    }

    if (latestDeposit.uuid !== lastCheckedDepositId) {
      lastCheckedDepositId = latestDeposit.uuid;
      return latestDeposit;
    }

    return null;
  } catch (error) {
    console.error('입금 체크 오류:', error);
    return null;
  }
}

// 입금 모니터링 시작
async function startDepositMonitoring(chatId) {
  if (depositMonitoringActive) {
    return '이미 입금 모니터링이 실행 중입니다.';
  }

  depositMonitoringActive = true;
  monitoringChatId = chatId;
  lastCheckedDepositId = null;

  // 초기 상태 설정 (현재까지의 입금은 무시)
  const deposits = await getUpbitDeposits('USDT', 'ACCEPTED', 1);
  if (deposits && deposits.length > 0) {
    lastCheckedDepositId = deposits[0].uuid;
  }

  console.log('입금 모니터링 시작됨');
  return '✅ 업비트 USDT 입금 모니터링을 시작합니다.\n새로운 입금이 감지되면 즉시 알려드립니다.';
}

// 입금 모니터링 중지
function stopDepositMonitoring() {
  if (!depositMonitoringActive) {
    return '현재 실행 중인 모니터링이 없습니다.';
  }

  depositMonitoringActive = false;
  monitoringChatId = null;
  lastCheckedDepositId = null;

  console.log('입금 모니터링 중지됨');
  return '⏸️ 입금 모니터링을 중지했습니다.';
}

// 주기적으로 입금 체크 (30초마다)
setInterval(async () => {
  if (!depositMonitoringActive || !monitoringChatId) {
    return;
  }

  const newDeposit = await checkUpbitDeposits();

  if (newDeposit) {
    const amount = parseFloat(newDeposit.amount);
    const fee = parseFloat(newDeposit.fee) || 0;
    const netAmount = amount - fee;
    const txid = newDeposit.txid || 'N/A';
    const network = newDeposit.net_type || 'Unknown';
    const time = new Date(newDeposit.done_at).toLocaleString('ko-KR');

    const message = `
🚨 <b>새로운 USDT 입금 감지!</b>

💰 <b>입금 금액</b>: ${amount.toFixed(2)} USDT
💸 <b>수수료</b>: ${fee.toFixed(2)} USDT
✅ <b>실제 입금</b>: ${netAmount.toFixed(2)} USDT
🌐 <b>네트워크</b>: ${network}
⏰ <b>입금 시간</b>: ${time}
🔗 <b>TxID</b>: ${txid.substring(0, 20)}...

입금이 완료되었습니다! 거래소에서 확인하세요.
    `.trim();

    await sendTelegramMessage(monitoringChatId, message);
    console.log(`새 입금 알림 전송: ${netAmount.toFixed(2)} USDT`);
  }
}, 30000); // 30초마다 체크

// 서버 시작
app.listen(PORT, async () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
  await initializeGoogleSheets();
});

// 헬스 체크
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

module.exports = app;
