/**
 * 김프방 자동화 시스템 - Node.js 서버
 * 텔레그램 봇과 구글 시트 연동
 */

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
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

// 구글 시트 API 설정
let sheets;
let auth;

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
      range: '계좌정보!W2:Z'
    });
    
    const data = response.data.values;
    if (!data || data.length < 2) return null;
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][3] === accountCode) { // Z열 (계좌코드)
        return {
          name: data[i][0], // W열 (이름)
          platform: data[i][1], // X열 (플랫폼)
          bankInfo: data[i][2] // Y열 (계좌정보)
        };
      }
    }
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
    const today = new Date();
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
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: '당일 작업!A:T',
      valueInputOption: 'RAW',
      resource: { values: [rowData] }
    });
    
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
      range: '당일 작업!A:T'
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
      range: `당일 작업!J${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[today]] }
    });
    
    // 외화입금 설정
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일 작업!L${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[amount]] }
    });
    
    // 외화출금 계산 (HKD:-15, USD:-2)
    const currencyType = await getCellValue('당일 작업!N' + row);
    const foreignWithdrawal = currencyType === 'HKD' ? 
      parseInt(amount) - 15 : parseInt(amount) - 2;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일 작업!M${row}`,
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
      range: `당일 작업!O${row}`,
      valueInputOption: 'RAW',
      resource: { values: [['진행']] }
    });
    
    const foreignWithdrawal = await getCellValue('당일 작업!M' + row);
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
      range: `당일 작업!P${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[amount]] }
    });
    
    // 최종달러 = 바낸달러 - 1
    const finalDollar = parseInt(amount) - 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일 작업!Q${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[finalDollar]] }
    });
    
    // 달러가격 업데이트
    await updateDollarPrice(row);
    
    const bankInfo = await getCellValue('당일 작업!D' + row);
    const name = await getCellValue('당일 작업!B' + row);
    const withdrawal = await getCellValue('당일 작업!F' + row);
    const dollarPrice = await getCellValue('당일 작업!S' + row);
    
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
      range: `당일 작업!E${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[amount]] }
    });
    
    // 수익 계산
    const finalDollar = await getCellValue('당일 작업!Q' + row);
    const dollarPrice = await getCellValue('당일 작업!S' + row);
    const withdrawal = await getCellValue('당일 작업!F' + row);
    
    const profit = Math.floor((finalDollar * dollarPrice - withdrawal) / 2);
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일 작업!G${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[profit]] }
    });
    
    const name = await getCellValue('당일 작업!B' + row);
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
      range: `당일 작업!H${row}`,
      valueInputOption: 'RAW',
      resource: { values: [[amount]] }
    });
    
    // 정산완료 설정
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `당일 작업!I${row}`,
      valueInputOption: 'RAW',
      resource: { values: [['정산완료']] }
    });
    
    const name = await getCellValue('당일 작업!B' + row);
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
      range: `당일 작업!I${row}`,
      valueInputOption: 'RAW',
      resource: { values: [['정산완료']] }
    });
    
    const name = await getCellValue('당일 작업!B' + row);
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
        range: `당일 작업!S${row}`,
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
    const response = await processTelegramCommand(text, userId, userName);
    
    // 텔레그램 봇으로 응답 전송
    await sendTelegramMessage(chatId, response);
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('웹훅 처리 오류:', error);
    res.status(500).send('Error');
  }
});

// 텔레그램 명령어 처리
async function processTelegramCommand(text, userId, userName) {
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

// 상태별 목록 조회 함수들 (구현 필요)
async function getWaitingList() {
  // 구현 예정
  return '대기 목록 조회 기능을 구현 중입니다.';
}

async function getProgressWaitingList() {
  return '진행대기 목록 조회 기능을 구현 중입니다.';
}

async function getProgressList() {
  return '진행중 목록 조회 기능을 구현 중입니다.';
}

async function getSettlementWaitingList() {
  return '정산대기 목록 조회 기능을 구현 중입니다.';
}

async function getSettlementList() {
  return '정산중 목록 조회 기능을 구현 중입니다.';
}

async function getSettlementCompleteList() {
  return '정산완료 목록 조회 기능을 구현 중입니다.';
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
